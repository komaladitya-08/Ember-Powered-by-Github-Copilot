import { describe, expect, it, vi } from "vitest";
import {
  bindWindowsCommandRootOnlyExitNative, WindowsCommandRootOnlyExitCleanupError, WINDOWS_COMMAND_ROOT_ONLY_EXIT_FUNCTION,
} from "../../app/main/agent/windows-command-exit-native";
import { WindowsCodingCleanupError } from "../../app/main/agent/windows-coding-native";

const PRIVATE = "PRIVATE path SID identity token secret";
function harness(implementation: (process: unknown, bytes: Buffer) => unknown = (_process, bytes) => { bytes.writeUInt32LE(0); return 1; }) {
  const query = vi.fn(implementation), func = vi.fn(() => query), load = vi.fn(() => ({ func }));
  const sizeof = vi.fn((name: unknown) => name === "void *" ? 8 : 4);
  const native = bindWindowsCommandRootOnlyExitNative({ sizeof }, load);
  return { native, query, func, load, sizeof };
}
const caught = (work: () => unknown) => {
  try { work(); } catch (error) {
    expect(error).toBeInstanceOf(WindowsCommandRootOnlyExitCleanupError); expect(error).toBeInstanceOf(WindowsCodingCleanupError);
    expect(String(error)).not.toContain(PRIVATE); expect((error as Error).cause).toBeUndefined(); return error;
  }
  throw new Error("The fixed exit query fault must refuse.");
};

describe("held-root exit native binding", () => {
  it.each([0, 1, 259, 0xc0000005, 0xffffffff])("returns the unsigned observed DWORD %i and clears the owned buffer", code => {
    let output: Buffer | undefined;
    const h = harness((process, bytes) => { expect(process).toBe(20n); expect(bytes.length).toBe(4); output = bytes; bytes.writeUInt32LE(code); return 1; });
    expect(h.native.exitCode(20n)).toBe(code); expect(output).toEqual(Buffer.alloc(4));
    expect(h.query).toHaveBeenCalledTimes(1); expect(h.load.mock.calls).toEqual([["kernel32.dll"]]);
    expect(h.func.mock.calls).toEqual([[WINDOWS_COMMAND_ROOT_ONLY_EXIT_FUNCTION]]); expect(Object.isFrozen(h.native)).toBe(true);
  });
  it.each([-0x80000000, -1, 2, 0x7fffffff])("accepts a nonzero signed Win32 BOOL %i", returned => {
    const h = harness((_process, bytes) => { bytes.writeUInt32LE(7); return returned; }); expect(h.native.exitCode(20n)).toBe(7);
  });
  it.each([0, true, false, null, undefined, NaN, 1.5, -0x80000001, 0x80000000, 1n, {}, Promise.resolve(1)])("retires on a failed or unknown return %#", returned => {
    let output: Buffer | undefined;
    const h = harness((_process, bytes) => { output = bytes; bytes.writeUInt32LE(0x12345678); return returned; });
    const error = caught(() => h.native.exitCode(20n));
    expect(output?.readUInt32LE(0)).toBe(0x12345678); // Unknown completion retains, rather than clears, the actual output.
    expect(caught(() => h.native.exitCode(20n))).toBe(error); expect(h.query).toHaveBeenCalledTimes(1);
  });
  it("retains the original output on a throwing call and preserves the first safe failure", () => {
    let output: Buffer | undefined;
    const h = harness((_process, bytes) => { output = bytes; bytes.writeUInt32LE(99); throw new Error(PRIVATE); });
    const error = caught(() => h.native.exitCode(20n)); expect(output?.readUInt32LE(0)).toBe(99);
    expect(caught(() => h.native.exitCode(21n))).toBe(error); expect(h.query).toHaveBeenCalledTimes(1);
  });
  it.each([0n, 21n])("keeps the first swallowed reentry failure and retains the outer output for handle %s", nested => {
    let output: Buffer | undefined, first: unknown;
    const h: ReturnType<typeof harness> = harness((_process, bytes) => {
      output = bytes; first = caught(() => h.native.exitCode(nested));
      bytes.writeUInt32LE(17); return 1;
    });
    expect(caught(() => h.native.exitCode(20n))).toBe(first);
    expect(output?.readUInt32LE(0)).toBe(17); expect(h.query).toHaveBeenCalledTimes(1);
    expect(caught(() => h.native.exitCode(20n))).toBe(first);
    expect(caught(() => h.native.exitCode(22n))).toBe(first); expect(h.query).toHaveBeenCalledTimes(1);
    expect(output?.readUInt32LE(0)).toBe(17);
  });
  it("refuses a detached output buffer and never attempts another query", () => {
    const h = harness((_process, bytes) => { structuredClone(bytes.buffer, { transfer: [bytes.buffer] }); return 1; });
    const error = caught(() => h.native.exitCode(20n)); expect(caught(() => h.native.exitCode(20n))).toBe(error); expect(h.query).toHaveBeenCalledTimes(1);
  });
  it.each([0n, -1n, 0x8000000000000000n, 20, null, undefined, {}])("refuses an invalid held-handle shape without native entry %#", process => {
    const h = harness(), error = caught(() => h.native.exitCode(process as bigint));
    expect(caught(() => h.native.exitCode(20n))).toBe(error); expect(h.query).not.toHaveBeenCalled();
  });
  it.each(["void *", "uint32_t", "int"])("checks the exact %s ABI before loading a DLL", bad => {
    const load = vi.fn(); caught(() => bindWindowsCommandRootOnlyExitNative({ sizeof: name => name === bad ? 2 : name === "void *" ? 8 : 4 }, load));
    expect(load).not.toHaveBeenCalled();
  });
  it.each([null, undefined, 1, {}])("refuses a non-function FFI declaration %#", query => {
    caught(() => bindWindowsCommandRootOnlyExitNative({ sizeof: name => name === "void *" ? 8 : 4 }, () => ({ func: () => query })));
  });
  it("keeps declaration and loader exceptions private", () => {
    caught(() => bindWindowsCommandRootOnlyExitNative({ sizeof: () => { throw new Error(PRIVATE); } }, () => { throw new Error("must not load"); }));
    caught(() => bindWindowsCommandRootOnlyExitNative({ sizeof: name => name === "void *" ? 8 : 4 }, () => { throw new Error(PRIVATE); }));
    caught(() => bindWindowsCommandRootOnlyExitNative({ sizeof: name => name === "void *" ? 8 : 4 }, () => ({ func: () => { throw new Error(PRIVATE); } })));
  });
});
