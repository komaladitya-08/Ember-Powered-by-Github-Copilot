/** Bounded observations carry no compiler text, source paths or successful-build authority. */
import fs from "node:fs";
import { expect, it } from "vitest";
// @ts-expect-error -- host-only JavaScript recipe and numeric observation boundary
import { windowsNodePosixRenameAbiObservation, windowsNodePosixRenameAbiSourceContext, windowsNodePosixRenameAbiBatch, windowsNodePosixSourceCliArguments, windowsNodePosixRenameAbiInvocation, parseWindowsNodePosixSourceBuildReceipt } from "../../scripts/experimental/build-windows-node-posix-source.mjs";

const phases = [1, 2, 3].map(value => `EMBER_NODE_POSIX_ABI_PHASE=${value}`);
const empty = { schema: 1, target: 1, phase: 0, exitCode: null, compilerCodes: [], overflow: 0, unknownLines: 0, sites: [], siteOverflow: 0 };
it.each([0, 1, 2, 3])("observes exact ordered whole stdout phase lines through %i", phase => {
  const value = windowsNodePosixRenameAbiObservation(1, { status: 1, stdout: phases.slice(0, phase).join("\r\n"), stderr: "" });
  expect(value).toEqual({ ...empty, phase, exitCode: 1 });
  expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.compilerCodes)).toBe(true);
});
it.each([1, 2])("keeps target %i distinct and retains a genuine child zero only as diagnostic data", target => {
  expect(windowsNodePosixRenameAbiObservation(target, { status: 0 })).toEqual({ ...empty, target, exitCode: 0 });
});
it("does not infer phases from unordered, partial, prefixed or stderr markers", () => {
  expect(windowsNodePosixRenameAbiObservation(2, { status: 0xffffffff, stdout: phases[2] + "\nprivate-" + phases[0] + "\n" + phases[0] + "\n" + phases[2], stderr: phases[1] })).toEqual({ ...empty, target: 2, phase: 1, exitCode: 0xffffffff, unknownLines: 4 });
});
it("projects only sorted unique bounded public diagnostic numbers", () => {
  const text = Array.from({ length: 12 }, (_, index) => `C:\\private\\source.c(99): error C${1011-index}: private value`).join("\n");
  const value = windowsNodePosixRenameAbiObservation(1, { status: 2, stdout: phases.slice(0, 2).join("\n"), stderr: text + "\nprivate warning C1000: private again\nprivate\n" });
  expect(value).toEqual({ ...empty, phase: 2, exitCode: 2, compilerCodes: [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007], overflow: 4, unknownLines: 1 });
  expect(JSON.stringify(value)).not.toMatch(/private|source|warning|error/);
});
it.each([undefined, null, [], {}, { get status() { throw new Error("private getter"); }, get stdout() { throw new Error("private getter"); } },
  { status: -1 }, { status: 0x100000000 }, { status: 1.5 }, { status: "1" }, { status: { valueOf() { throw new Error("private coercion"); } } },
  new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("private descriptor"); } }),
])("ignores malformed, foreign and accessor child fields %#", result => {
  expect(windowsNodePosixRenameAbiObservation(1, result)).toEqual(empty);
});
it("bounds unknown output and refuses oversized or object output without coercion", () => {
  expect(windowsNodePosixRenameAbiObservation("private", { stdout: "\n".repeat(65_536) + "private", stderr: { toString() { throw new Error("private"); } } })).toEqual({ ...empty, target: 0, unknownLines: 2 });
  expect(windowsNodePosixRenameAbiObservation(1, { stdout: Buffer.from(phases[0]), stderr: Buffer.from("fatal error C1083: private path") })).toEqual({ ...empty, phase: 1, compilerCodes: [1083] });
});
it("does not accept a phase or compiler witness as a successful asset receipt", () => {
  const value = windowsNodePosixRenameAbiObservation(1, { status: 0, stdout: phases.join("\n") });
  expect(() => parseWindowsNodePosixSourceBuildReceipt(Buffer.from(JSON.stringify(value)), "a".repeat(40))).toThrow();
});
const args = ["--source-archive", "fixed-source", "--nasm-archive", "fixed-nasm", "--destination", "fresh", "--python", "trusted"];
it("admits only the exact optional ABI-only diagnostic literal and leaves full builds mandatory", () => {
  expect(windowsNodePosixSourceCliArguments(args)).toEqual({ abiOnly: false, options: { sourceArchivePath: "fixed-source", nasmArchivePath: "fixed-nasm", destination: "fresh", pythonPath: "trusted" } });
  expect(windowsNodePosixSourceCliArguments([...args, "--abi-only"])).toMatchObject({ abiOnly: true });
});
it.each(["--skip-abi", "--compile", "--source-build", "private"]) ("refuses unknown CLI scope %s", flag => {
  expect(() => windowsNodePosixSourceCliArguments([...args, flag])).toThrow();
});
it("retains each original compile target and flags with fixed batch milestones", () => {
  const paths = { vcvars: "C:\\VS\\vcvarsall.bat", compiler: "C:\\VS\\cl.exe", working: "D:\\working", source: "D:\\abi\\check.c", include: "D:\\abi", object0: "D:\\abi\\win8.obj", object1: "D:\\abi\\sdk.obj" };
  for (const target of [1, 2]) {
    const text = windowsNodePosixRenameAbiBatch(paths, target);
    expect(text.match(/\/W4 \/WX \/TC \/std:c11 \/c /g)).toHaveLength(1);
    const markers = phases.map(marker => text.indexOf(`echo ${marker}`));
    expect(markers[0]).toBeLessThan(text.indexOf('call "')); expect(markers[1]).toBeLessThan(text.indexOf('/W4 /WX'));
    expect(markers[2]).toBeGreaterThan(text.indexOf('/W4 /WX')); expect(text).not.toMatch(/vcbuild|\/link/);
  }
  for (const value of [undefined, 0, 3, "1"]) expect(() => windowsNodePosixRenameAbiBatch(paths, value)).toThrow();
});
it("defaults workflow dispatch to ABI-only and prevents diagnostic artifact uploads", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/experimental-windows-node-posix-source.yml", import.meta.url), "utf8");
  expect(workflow).toContain("default: abi-only"); expect(workflow).toContain("steps.build.outcome == 'success' && inputs.probe == 'source-build'");
  expect(workflow).toContain("$arguments += '--abi-only'");
});

it.each(["D:\\fresh\\compile-abi-1.cmd", "D:\\trusted directory\\compile abi.cmd"])("passes one quoted batch command verbatim for trusted path %s", batch => {
  const env = { SystemRoot: "C:\\Windows" }, cwd = "D:\\trusted directory";
  const command = windowsNodePosixRenameAbiInvocation("C:\\Windows\\System32\\cmd.exe", batch, env, cwd);
  expect(command.program).toBe("C:\\Windows\\System32\\cmd.exe");
  expect(command.args).toEqual(["/d", "/s", "/v:off", "/c", `""${batch}""`]);
  expect(command.options).toEqual({ env, cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 65_536, windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"] });
  expect(command.options.env).toBe(env); expect(Object.isFrozen(env)).toBe(false);
  expect(Object.isFrozen(command)).toBe(true); expect(Object.isFrozen(command.args)).toBe(true); expect(Object.isFrozen(command.options)).toBe(true); expect(Object.isFrozen(command.options.stdio)).toBe(true);
});
it.each([null, 1, {}, "D:\\bad&command.cmd", "D:\\bad%PATH%.cmd", "D:\\bad!value.cmd", "D:\\bad^escape.cmd", "D:\\bad;command.cmd", 'D:\\bad"quoted.cmd', "D:\\file:stream", "D:\\dir\\..\\escape.cmd", "\\\\server\\share\\file.cmd", "D:\\bad\nline.cmd"])("refuses malformed or command-bearing invocation paths %#", value => {
  for (const index of [0, 1, 2]) {
    const paths: unknown[] = ["C:\\Windows\\System32\\cmd.exe", "D:\\fresh\\compile.cmd", "D:\\fresh"];
    paths[index] = value;
    expect(() => windowsNodePosixRenameAbiInvocation(paths[0], paths[1], {}, paths[2])).toThrow();
  }
});

const sourceInputs = { source: "D:\\fresh\\rename-abi.c", adapter: "D:\\fresh\\node-posix-adapter.inc", working: "D:\\source\\working", sdkInclude: "C:\\SDK\\Include\\10.0.26100.0", vcInclude: "C:\\VC\\include" };
const observeSite = (text: string, context: unknown = windowsNodePosixRenameAbiSourceContext(sourceInputs)) => windowsNodePosixRenameAbiObservation(2, { status: 1, stderr: text }, context);
it.each([[sourceInputs.source, 1], [sourceInputs.adapter, 2], ["D:\\source\\working\\deps\\uv\\include\\uv.h", 3], ["D:\\source\\working\\deps\\uv\\src\\uv-common.h", 5], ["C:\\SDK\\Include\\10.0.26100.0\\um\\WinBase.h", 8], ["C:\\SDK\\Include\\10.0.26100.0\\ucrt\\assert.h", 10]])("maps only exact known source %s to finite class %i", (file, sourceClass) => {
  const observed = observeSite(`${String(file).toUpperCase()}(24,7): warning C5287: private operands`);
  expect(observed.sites).toEqual([{ sourceClass, line: 24, column: 7, code: 5287 }]);
  expect(Object.isFrozen(observed.sites)).toBe(true); expect(Object.isFrozen(observed.sites[0])).toBe(true);
  expect(JSON.stringify(observed)).not.toMatch(/private|fresh|working|SDK|WinBase|operands|D:/);
});
it.each(["C:\\private\\rename-abi.c", "D:\\fresh-other\\rename-abi.c", "rename-abi.c", "D:\\private\\..\\fresh\\rename-abi.c", "D:\\fresh\\rename-abi.c:stream", "C:\\SDK\\Include\\other-version\\um\\WinBase.h"])("does not recover a known suffix from foreign source %s", file => {
  expect(observeSite(`${file}(24,7): warning C5287: private`).sites).toEqual([{ sourceClass: 0, code: 5287 }]);
});
it.each(["0", "65536", "-1", "1.5", "9999999", "1,0", "1,65536", "1,-1"])("omits invalid or unbounded line/column %s", position => {
  expect(observeSite(`${sourceInputs.source}(${position}): warning C5287: private`).sites).toEqual([{ sourceClass: 0, code: 5287 }]);
});
it("accepts bounded positive locations, deduplicates and caps sorted site facts", () => {
  const text = Array.from({ length: 11 }, (_, index) => `${sourceInputs.source}(${11-index}): warning C5287: private`).join("\n");
  const observed = observeSite(text + `\n${sourceInputs.source}(1): warning C5287: private`);
  expect(observed.sites).toEqual(Array.from({ length: 8 }, (_, index) => ({ sourceClass: 1, line: index + 1, code: 5287 })));
  expect(observed.siteOverflow).toBe(3);
  expect(observeSite(`${sourceInputs.source}(65535,65535): error C2220: private`).sites).toEqual([{ sourceClass: 1, line: 65535, column: 65535, code: 2220 }]);
});
it("requires a privately minted context and snapshots its input values", () => {
  const input = { ...sourceInputs }, context = windowsNodePosixRenameAbiSourceContext(input); input.source = "D:\\other\\rename-abi.c";
  expect(Object.isFrozen(context)).toBe(true); expect(Object.keys(context)).toEqual([]);
  expect(observeSite(`${sourceInputs.source}(9): warning C5287: private`, context).sites).toEqual([{ sourceClass: 1, line: 9, code: 5287 }]);
  for (const value of [{}, { source: sourceInputs.source }, new Proxy({}, { get() { throw new Error("private getter"); } })]) expect(observeSite(`${sourceInputs.source}(9): warning C5287: private`, value).sites).toEqual([]);
  const other = windowsNodePosixRenameAbiSourceContext({ ...sourceInputs, source: "D:\\other\\rename-abi.c", adapter: "D:\\other\\node-posix-adapter.inc" });
  expect(observeSite(`${sourceInputs.source}(9): warning C5287: private`, other).sites).toEqual([{ sourceClass: 0, code: 5287 }]);
});
it("refuses source-context getters, arbitrary filenames and mismatched copied parents", () => {
  for (const input of [{ ...sourceInputs, get source() { throw new Error("private getter"); } }, { ...sourceInputs, source: "D:\\fresh\\private.txt" }, { ...sourceInputs, adapter: "D:\\other\\node-posix-adapter.inc" }]) expect(() => windowsNodePosixRenameAbiSourceContext(input)).toThrow("exact source, recipe or issuer");
});

it.each(["d:/fresh/rename-abi.c", "d:\\fresh/rename-abi.c"])("normalises only full known source spelling %s", file => {
  expect(observeSite(`${file}(9): warning C5287: private`).sites).toEqual([{ sourceClass: 1, line: 9, code: 5287 }]);
});
