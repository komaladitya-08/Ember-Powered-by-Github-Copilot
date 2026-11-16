import vm from "node:vm";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { parseWindowsNodeSourceChildReport, inspectWindowsNodeSourceTestOutput } from "../fixtures/windows-node-source-child-report";
// @ts-expect-error -- fixed trusted runtime literals, deliberately outside application bundles
import { windowsNodeSourceChildPrograms, windowsNodeSourceChildProgramReceipts } from "../fixtures/windows-node-source-child-program.mjs";

const tap = "TAP version 13\n# Subtest: fixed source Node local test\nok 1 - fixed source Node local test\n  ---\n  duration_ms: 3.141\n  type: 'test'\n  ...\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 44.12\n";
function report(role: 0 | 1, mode: "spawn" | "test") {
  const bytes = Buffer.alloc(64), words = [0x43534e45, 1, role, mode === "spawn" ? 1 : 2, 4, 1, 31, mode === "spawn" ? 12 : 0, mode === "spawn" ? 14 : 0, 0, 1, 1, 1, 1, 22023005, 0];
  words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4)); return bytes;
}
it.each([0, 1] as const)("decodes a complete fixed report for role %s without retaining mutable bytes", role => {
  for (const mode of ["spawn", "test"] as const) {
    const bytes = report(role, mode), result = parseWindowsNodeSourceChildReport(bytes, role, mode); bytes.fill(0);
    expect(result).toMatchObject({ role, mode, complete: true, features: 31 }); expect(Object.isFrozen(result)).toBe(true);
  }
});
it.each(Array.from({ length: 16 }, (_, i) => i))("refuses contradictory/unknown report field %s", index => {
  const bytes = report(1, "spawn"); bytes.writeUInt32LE(index === 13 ? 501 : bytes.readUInt32LE(index * 4) + 1, index * 4);
  expect(() => parseWindowsNodeSourceChildReport(bytes, 1, "spawn")).toThrow("incomplete or malformed");
});
it.each([0, 1, 63, 65, 128])("refuses partial/oversized child report length %s", length => {
  expect(() => parseWindowsNodeSourceChildReport(Buffer.alloc(length), 1, "spawn")).toThrow();
});
it("accepts only one exact passing test with bounded duration fields", () => {
  expect(inspectWindowsNodeSourceTestOutput(Buffer.from(tap))).toEqual({ accepted: true, tests: 1, passed: 1 });
  expect(inspectWindowsNodeSourceTestOutput(Buffer.from(tap.replaceAll("\n", "\r\n")))).toEqual({ accepted: true, tests: 1, passed: 1 });
});
it.each([
  tap + "private warning\n", tap.replace("# tests 1", "# tests 2"), tap.replace("# pass 1", "# pass 0"), tap.replace("# fail 0", "# fail 1"),
  tap.replace("# skipped 0", "# skipped 1"), tap.replace("# cancelled 0", "# cancelled 1"), tap.replace("ok 1 -", "not ok 1 -"),
  tap.replace("fixed source Node local test", "private title"), tap.replace("  duration_ms: 3.141", "  duration_ms: NaN"),
  tap.replace("1..1", "1..2"), tap.slice(0, -1), tap + "\0", "\ufeff" + tap, tap.replace("TAP", "T\rAP"), "x".repeat(4097), "",
])("refuses extra/malformed TAP without returning its content %#", value => {
  expect(inspectWindowsNodeSourceTestOutput(Buffer.from(value))).toEqual({ accepted: false, tests: 0, passed: 0 });
});
it("binds every literal role/mode to detached bytes and digest receipts", () => {
  const receipts = windowsNodeSourceChildProgramReceipts();
  for (const role of ["host", "lpac"] as const) for (const mode of ["spawn", "test"] as const) {
    const program = windowsNodeSourceChildPrograms[role][mode];
    expect(receipts[role][mode]).toEqual({ bytes: Buffer.byteLength(program), sha256: createHash("sha256").update(program).digest("hex") });
    expect(program).not.toContain("__EMBER_");
  }
});
it.each(["host", "lpac"] as const)("exercises actual ordinary-process three-pipe transport for fixed %s literal (not Windows evidence)", async role => {
  let captured: Buffer | undefined, child: ReturnType<typeof spawn> | undefined;
  const files = { readFileSync: () => Buffer.from("EMBER_ACK_1\n"), openSync: () => 10,
    writeSync: (_fd: number, bytes: Buffer) => { captured = Buffer.from(bytes); return bytes.length; }, fsyncSync() {}, closeSync() {} };
  const processStub = { versions: { node: "22.23.5" }, env: { EMBER_LPAC_TOOLS: "C:\\fixed\\tools", EMBER_LPAC_STATE: "C:\\fixed\\state" }, execPath: process.execPath, exitCode: 0 };
  const context = vm.createContext({ Buffer, process: processStub, setTimeout, clearTimeout,
    require: (name: string) => name === "node:fs" ? files : name === "node:child_process" ? { spawn(program: string, args: string[], options: unknown) {
      expect(program).toBe(process.execPath); expect(options).toEqual({ stdio: ["pipe", "pipe", "pipe"] }); expect(args[0]).toBe("--eval");
      child = spawn(program, args, options as Parameters<typeof spawn>[2]); return child;
    } } : name === "node:path" ? { win32: { join: (...parts: string[]) => parts.join("\\") } } : undefined });
  try {
    await vm.runInContext(windowsNodeSourceChildPrograms[role].spawn, context);
    const until = Date.now() + 4000;
    while (!captured && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    expect(processStub.exitCode).toBe(0); expect(captured).toBeDefined();
    expect(parseWindowsNodeSourceChildReport(captured!, role === "host" ? 0 : 1, "spawn")).toMatchObject({ stdinBytes: 12, stdoutBytes: 14, stderrBytes: 0 });
  } finally { if (child && child.exitCode === null) child.kill(); captured?.fill(0); }
}, 7000);
it("registers one default-test literal and runs its fixed assertion only after grant (logic-only)", async () => {
  let callback: (() => Promise<void>) | undefined, captured: Buffer | undefined;
  const context = vm.createContext({ Buffer, process: { versions: { node: "22.23.5" }, env: { EMBER_LPAC_TOOLS: "C:\\fixed\\tools", EMBER_LPAC_STATE: "C:\\fixed\\state" }, exitCode: 0 }, setTimeout,
    require: (name: string) => name === "node:test" ? (title: string, run: () => Promise<void>) => { expect(title).toBe("fixed source Node local test"); expect(callback).toBeUndefined(); callback = run; }
      : name === "node:assert/strict" ? { equal: (a: number, b: number) => expect(a).toBe(b) }
      : name === "node:path" ? { win32: { join: (...parts: string[]) => parts.join("\\") } }
      : name === "node:fs" ? { readFileSync: () => Buffer.from("EMBER_ACK_1\n"), openSync: () => 10, writeSync: (_fd: number, bytes: Buffer) => { captured = Buffer.from(bytes); return bytes.length; }, fsyncSync() {}, closeSync() {} } : undefined });
  vm.runInContext(windowsNodeSourceChildPrograms.lpac.test, context); expect(callback).toBeDefined(); expect(captured).toBeUndefined();
  await callback!(); expect(parseWindowsNodeSourceChildReport(captured!, 1, "test")).toMatchObject({ complete: true });
});
