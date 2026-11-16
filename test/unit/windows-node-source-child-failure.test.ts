/** Fixed literal/decoder logic only. No Windows ABI, process admission or pre-fixture test-runner proof. */
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { parseWindowsNodeSourceChildFailure, windowsNodeSourceChildFailureFileName, WINDOWS_NODE_SOURCE_CHILD_FAILURE_BYTES, WINDOWS_NODE_SOURCE_CHILD_FAILURE_CODES } from "../fixtures/windows-node-source-child-failure";
// @ts-expect-error -- fixed trusted runtime literals, deliberately outside the compile recipe and app bundles
import { windowsNodeSourceChildPrograms, windowsNodeSourceChildProgramReceipts } from "../fixtures/windows-node-source-child-program.mjs";

function frame(role: 0 | 1 = 1, mode: "spawn" | "test" = "spawn") {
  const bytes = Buffer.alloc(48), words = [0x46434e45, 1, role, mode === "spawn" ? 1 : 2, mode === "spawn" ? 3 : 10, 1, 1, 0, 22023005, 0, 0, 0];
  words.forEach((value, index) => bytes.writeUInt32LE(value, index * 4)); bytes.writeInt32LE(-4092, 28); return bytes;
}
function fixture(role: "host" | "lpac" = "lpac", mode: "spawn" | "test" = "spawn") {
  const child = new EventEmitter() as EventEmitter & { stdin: EventEmitter & { end(bytes: Buffer): void }; stdout: EventEmitter; stderr: EventEmitter };
  child.stdin = Object.assign(new EventEmitter(), { end(_bytes: Buffer) {} }); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const descriptors = new Map<number, string>(), files = new Map<string, Buffer>(), sourceBuffers: Buffer[] = [];
  let descriptor = 10, testCallback: (() => Promise<void>) | undefined;
  const control = { spawnError: undefined as unknown, writeError: false, closeError: false, assertions: false, nodeTestError: undefined as unknown };
  const processStub = { versions: { node: "22.23.5" }, env: { EMBER_LPAC_TOOLS: "C:\\fixed\\tools", EMBER_LPAC_STATE: "C:\\fixed\\state" }, execPath: "C:\\fixed\\source-node.exe", exitCode: 0 };
  const filesystem = { readFileSync: () => Buffer.from("EMBER_ACK_1\n", "ascii"),
    openSync(file: string, flags: string, mode: number) { expect(flags).toBe("wx"); expect(mode).toBe(0o600); expect(files.has(file)).toBe(false); const fd = descriptor++; descriptors.set(fd, file); return fd; },
    writeSync(fd: number, data: Buffer, offset: number, length: number, position: number) {
      expect(position).toBe(0); sourceBuffers.push(data);
      if (control.writeError) throw new Error("private write error"); files.set(descriptors.get(fd)!, Buffer.from(data.subarray(offset, offset + length))); return length;
    }, fsyncSync() {}, closeSync(fd: number) { descriptors.delete(fd); if (control.closeError) throw new Error("private close error"); },
  };
  const context = vm.createContext({ Buffer, process: processStub, setTimeout, clearTimeout,
    require: (name: string) => name === "node:fs" ? filesystem : name === "node:path" ? { win32: { join: (...parts: string[]) => parts.join("\\") } }
      : name === "node:child_process" ? { spawn(program: string, args: string[], options: unknown) {
        expect(program).toBe(processStub.execPath); expect(args[0]).toBe("--eval"); expect(options).toEqual({ stdio: ["pipe", "pipe", "pipe"] });
        if (control.spawnError !== undefined) throw control.spawnError; return child;
      } } : name === "node:test" ? (title: string, callback: () => Promise<void>) => {
        if (control.nodeTestError !== undefined) throw control.nodeTestError;
        expect(title).toBe("fixed source Node local test"); expect(testCallback).toBeUndefined(); testCallback = callback;
      } : name === "node:assert/strict" ? { equal(a: number, b: number) { expect(a).toBe(6 * 7); expect(b).toBe(42); if (control.assertions) throw new Error("private assertion details"); } } : undefined,
  });
  const file = "C:\\fixed\\state\\" + windowsNodeSourceChildFailureFileName(role === "host" ? 0 : 1, mode);
  return { child, files, sourceBuffers, control, processStub, descriptors,
    run: () => vm.runInContext(windowsNodeSourceChildPrograms[role][mode], context),
    enteredTest: () => testCallback,
    read: () => { const bytes = files.get(file); expect(bytes).toBeDefined(); return parseWindowsNodeSourceChildFailure(bytes!, role === "host" ? 0 : 1, mode); },
  };
}
it.each([0, 1] as const)("binds both fixed role/mode names and detached48-byte facts for role %s", role => {
  for (const mode of ["spawn", "test"] as const) {
    const expected = `${role ? "lpac" : "host"}-source-child-${mode === "spawn" ? 1 : 2}-failure.bin`;
    expect(windowsNodeSourceChildFailureFileName(role, mode)).toBe(expected);
    const bytes = frame(role, mode), result = parseWindowsNodeSourceChildFailure(bytes, role, mode); bytes.fill(0);
    expect(result).toEqual({ schema: 1, role, mode, operation: mode === "spawn" ? 3 : 10, code: 1, errno: -4092 }); expect(Object.isFrozen(result)).toBe(true);
  }
  expect(WINDOWS_NODE_SOURCE_CHILD_FAILURE_BYTES).toBe(48);
});
it.each([0, 1, 47, 49, 96])("rejects partial, absent or oversized diagnostic bytes: %s", length => expect(() => parseWindowsNodeSourceChildFailure(Buffer.alloc(length), 1, "spawn")).toThrow("malformed"));
it.each([0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11])("rejects malformed or contradictory fixed field %s", index => {
  const bytes = frame(); bytes.writeUInt32LE(index === 4 ? 12 : index === 5 ? 17 : index === 6 ? 2 : bytes.readUInt32LE(index * 4) + 1, index * 4);
  expect(() => parseWindowsNodeSourceChildFailure(bytes, 1, "spawn")).toThrow("malformed");
});
it("rejects an errno without presence and impossible mode/operation combinations", () => {
  const bytes = frame(); bytes.writeUInt32LE(0, 24); expect(() => parseWindowsNodeSourceChildFailure(bytes, 1, "spawn")).toThrow();
  bytes.writeInt32LE(0, 28); expect(parseWindowsNodeSourceChildFailure(bytes, 1, "spawn")).not.toHaveProperty("errno");
  bytes.writeUInt32LE(10, 16); expect(() => parseWindowsNodeSourceChildFailure(bytes, 1, "spawn")).toThrow();
  const test = frame(1, "test"); test.writeUInt32LE(3, 16); expect(() => parseWindowsNodeSourceChildFailure(test, 1, "test")).toThrow();
  expect(() => windowsNodeSourceChildFailureFileName(2 as 0, "spawn")).toThrow();
  expect(() => parseWindowsNodeSourceChildFailure(frame(), 1, "other" as "spawn")).toThrow();
});
it.each([-2147483648, -4092, -1, 0, 1, 2147483647])("preserves only the captured signed32 errno value, with no inferred correlation: %s", errno => {
  const bytes = frame(); bytes.writeInt32LE(errno, 28); expect(parseWindowsNodeSourceChildFailure(bytes, 1, "spawn").errno).toBe(errno);
});
it.each(["host", "lpac"] as const)("captures a synchronous spawn exception using own descriptors only for %s", async role => {
  const value = fixture(role), error = Object.assign(new Error("private native path and message"), { code: "EACCES", errno: -4092 });
  Object.defineProperties(error, { path: { get() { throw new Error("private path read"); } }, syscall: { get() { throw new Error("private syscall read"); } } });
  value.control.spawnError = error; await value.run();
  expect(value.read()).toEqual({ schema: 1, role: role === "host" ? 0 : 1, mode: "spawn", operation: 2, code: 1, errno: -4092 });
  expect(value.processStub.exitCode).toBe(1); expect(value.files.size).toBe(1); expect(value.descriptors.size).toBe(0);
  expect(value.sourceBuffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
});
it.each(WINDOWS_NODE_SOURCE_CHILD_FAILURE_CODES.slice(1).map((code, index) => [code, index + 1] as const))("records the exact public code enum %s without publishing the string", async (code, expected) => {
  const value = fixture(); value.control.spawnError = { code }; await value.run();
  expect(value.read()).toEqual({ schema: 1, role: 1, mode: "spawn", operation: 2, code: expected });
});
it.each([undefined, "private", 2n, NaN, Infinity, -2147483649, 2147483648, false, {}])("omits malformed errno and unknown code data without coercion: %#", async errno => {
  const value = fixture(); value.control.spawnError = { code: "private code and path", errno }; await value.run();
  expect(value.read()).toEqual({ schema: 1, role: 1, mode: "spawn", operation: 2, code: 0 });
});
it("does not read code/errno getters, inherited values or arbitrary error properties", async () => {
  let reads = 0;
  const value = fixture(), error = Object.create({ code: "EACCES", errno: -4092 });
  for (const name of ["code", "errno", "message", "path", "stack", "syscall", "spawnargs"]) Object.defineProperty(error, name, { get() { reads++; throw new Error("private getter"); } });
  value.control.spawnError = error; await value.run(); expect(value.read()).toMatchObject({ operation: 2, code: 0 }); expect(value.read()).not.toHaveProperty("errno"); expect(reads).toBe(0);
});
it("handles descriptor traps as unknown rather than forwarding their private exception", async () => {
  const value = fixture(); value.control.spawnError = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("private descriptor trap"); } }); await value.run();
  expect(value.read()).toEqual({ schema: 1, role: 1, mode: "spawn", operation: 2, code: 0 });
});
it("keeps the first native child error ahead of later stream, lifecycle and output failures", async () => {
  const value = fixture(); await value.run();
  value.child.emit("error", { code: "EPERM", errno: -4048 });
  value.child.stdin.emit("error", { code: "EPIPE", errno: -4047 });
  value.child.stderr.emit("data", Buffer.from("private stderr")); value.child.emit("exit", 1, null); value.child.emit("close", 1, null);
  expect(value.read()).toEqual({ schema: 1, role: 1, mode: "spawn", operation: 3, code: 2, errno: -4048 });
  expect(value.files.size).toBe(1); expect(value.processStub.exitCode).toBe(1);
});
it("keeps an earlier missing-stdio setup failure unknown when the native child error arrives later", async () => {
  const value = fixture(); Object.defineProperty(value.child, "stdin", { value: undefined }); await value.run();
  expect(value.read()).toEqual({ schema: 1, role: 1, mode: "spawn", operation: 1, code: 0 });
  value.child.emit("error", { code: "EACCES", errno: -4092 });
  expect(value.read()).toEqual({ schema: 1, role: 1, mode: "spawn", operation: 1, code: 0 });
  expect(value.files.size).toBe(1); expect(value.processStub.exitCode).toBe(1);
});
it.each([["stdin", 4], ["stdout", 5], ["stderr", 6]] as const)("captures the existing %s error handler without private output", async (stream, operation) => {
  const value = fixture(); await value.run(); value.child[stream].emit("error", { code: "EIO", errno: -4070 }); expect(value.read()).toMatchObject({ operation, code: 9, errno: -4070 });
});
it("does not write a failure file during valid fixed spawn completion", async () => {
  const value = fixture(); await value.run(); value.child.emit("spawn"); value.child.stdout.emit("data", Buffer.from("EMBER_STDIO_1\n")); value.child.emit("exit", 0, null); value.child.emit("close", 0, null);
  expect(value.processStub.exitCode).toBe(0); expect([...value.files.keys()]).toEqual(["C:\\fixed\\state\\lpac-source-child-1-report.bin"]);
});
it("preserves default test registration/success and cannot report before its fixture enters", async () => {
  const value = fixture("lpac", "test"); expect(value.files.size).toBe(0); value.run();
  expect(value.enteredTest()).toBeDefined(); expect(value.files.size).toBe(0); await value.enteredTest()!();
  expect(value.processStub.exitCode).toBe(0); expect([...value.files.keys()]).toEqual(["C:\\fixed\\state\\lpac-source-child-2-report.bin"]);
  // A default test-root failure before it loads this literal has no writer; absence remains unknown, not a fabricated cause.
  expect(() => parseWindowsNodeSourceChildFailure(Buffer.alloc(0), 1, "test")).toThrow();
});
it("records an entered test-fixture failure and rethrows the authoritative error for the existing test runner", async () => {
  const value = fixture("lpac", "test"); value.control.assertions = true; value.run();
  await expect(value.enteredTest()!()).rejects.toThrow("private assertion details");
  expect(value.read()).toEqual({ schema: 1, role: 1, mode: "test", operation: 10, code: 0 });
});
it.each(["writeError", "closeError"] as const)("writes no raw failure output or retries when the fixed failure file encounters %s", async fault => {
  const value = fixture(); value.control[fault] = true; value.control.spawnError = { code: "EACCES", errno: -4092 }; await value.run();
  expect(value.processStub.exitCode).toBe(1); expect(value.descriptors.size).toBe(0); expect(value.sourceBuffers).toHaveLength(1); expect(value.sourceBuffers[0].every(byte => byte === 0)).toBe(true);
  if (fault === "writeError") expect(value.files.size).toBe(0); else expect(value.read()).toMatchObject({ code: 1, errno: -4092 });
});
it("keeps the changed run literals independently receipted and bounded without a compile-recipe input", () => {
  const receipts = windowsNodeSourceChildProgramReceipts();
  for (const role of ["host", "lpac"] as const) for (const mode of ["spawn", "test"] as const) {
    expect(receipts[role][mode].bytes).toBe(Buffer.byteLength(windowsNodeSourceChildPrograms[role][mode]));
    expect(receipts[role][mode].bytes).toBeLessThan(16 * 1024);
  }
});
