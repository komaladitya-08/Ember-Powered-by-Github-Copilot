import { expect, it, vi } from "vitest";
import fs from "node:fs";
import { outputFake } from "../fixtures/windows-command-output-fake";
import { requireWindowsCommandRootOnlyCompleted, WindowsRootOnlyCommandCopyCleanupError } from "../../app/main/agent/windows-command-copy";
import { requireWindowsCommandOutputClosed, requireWindowsCommandOutputLaunch, WindowsCommandOutputCleanupError } from "../../app/main/agent/windows-command-output";
import { closeWindowsCommandCreatorProfile, WindowsCommandCreatorProfileCleanupError } from "../../app/main/agent/windows-command-creator-profile";
import { createWindowsCommandRootOnlyStopOwner, requireWindowsCommandRootOnlyStopped, WindowsCommandRootOnlyCleanupError, type WindowsCommandRootOnlyStopOwner } from "../../app/main/agent/windows-command-stop";
import { WindowsCommandCopyCleanupError } from "../../app/main/agent/windows-command-copy-native";
import { WindowsNodeToolchainCleanupError } from "../../app/main/agent/windows-node-toolchain-native";
import { WindowsCommandCopyProofCleanupError } from "../fixtures/windows-command-copy-proof-native";
import { WindowsNodeAssetEnforcementNativeCleanupError } from "../fixtures/windows-node-asset-enforcement-native";
import { bindWindowsNodeAssetEnforcement, observeWindowsNodeAssetStop, requireWindowsNodeAssetOutputFacts,
  windowsNodeAssetCreationSecurity, windowsNodeAssetPreludeExit, windowsNodeAssetPreludeProbe, windowsNodeAssetErrorClass, requireWindowsNodeAssetHeldToken, requireWindowsNodeAssetTokenFacts, NODE_ASSET_READY, NODE_ASSET_ERROR_READY, WindowsNodeAssetEnforcementObservationError } from "../fixtures/windows-node-asset-enforcement-proof";
import type { WindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";

const loaded = { requireWindowsCommandRootOnlyCompleted, requireWindowsCommandOutputClosed };
const until = async (check: () => boolean) => { const deadline = performance.now() + 4000; while (!check()) { if (performance.now() > deadline) throw Error("Fixed portable asset deadline."); await new Promise<void>(resolve => setTimeout(resolve, 5)); } };
const chunks = (s: ReturnType<typeof outputFake>, stream: number, bytes: Buffer) => { for (let at = 0; at < bytes.length; at += 16384) s.enqueue(stream, bytes.subarray(at, at + 16384)); };
async function natural(prelude = false, exitCode = prelude ? 39 : 17, frames?: { stdout?: Buffer; stderr?: Buffer }) {
  const s = outputFake(), v = await s.launch(); s.state.code = exitCode;
  const stdout = frames?.stdout ?? (prelude ? Buffer.from("EMBER_ASSET_ACCESS_V3:32767:131071:15:17:2:1\n") : Buffer.concat([Buffer.from(NODE_ASSET_READY), Buffer.alloc(73728, 79), Buffer.from("\nEMBER_NODE_ASSET_DONE\n")]));
  const stderr = frames?.stderr ?? (prelude ? Buffer.from("EMBER_ASSET_ACCESS_STDERR_V3\n") : Buffer.concat([Buffer.from(NODE_ASSET_ERROR_READY), Buffer.alloc(67584, 69), Buffer.from("\nEMBER_NODE_ASSET_STDERR_DONE\n")]));
  chunks(s, 0, stdout); chunks(s, 1, stderr); s.state.ended = true;
  const completed = await v.copy.completeRootOnly(v.run, v.io.signal), closed = await v.io.closeOutputAfterStopped(completed, v.run);
  await v.copy.close(); closeWindowsCommandCreatorProfile(s.profile);
  return { s, input: { mode: prelude ? "prelude" as const : "natural" as const, completed, closed, run: v.run, launch: v.ref, stdout, stderr } };
}
it.each([false, true])("fixed genuine natural/C access output requires real closed exact-run references %#", async prelude => {
  const { s, input } = await natural(prelude);
  expect(requireWindowsNodeAssetOutputFacts(loaded, input)).toMatchObject({ exitCode: prelude ? 39 : 17, reason: "none", complete: true });
  expect([...s.handles.values()].every(handle => handle.closed)).toBe(true); expect([...s.allocations.values()].every(allocation => allocation.freed)).toBe(true);
});
it.each([
  { code: 19, stdout: "EMBER_ASSET_ACCESS_V1:255:511:1\n", stderr: "EMBER_ASSET_ACCESS_STDERR\n" },
  { code: 39, stdout: "EMBER_ASSET_ACCESS_V1:255:511:1\n", stderr: "EMBER_ASSET_ACCESS_STDERR\n" },
  { code: 19, stdout: "EMBER_ASSET_ACCESS_V3:32767:131071:15:17:2:1\n", stderr: "EMBER_ASSET_ACCESS_STDERR_V3\n" },
  { code: 29, stdout: "EMBER_ASSET_ACCESS_V2:131071:2047:17:11:2:1\n", stderr: "EMBER_ASSET_ACCESS_STDERR_V2\n" },
  { code: 39, stdout: "EMBER_ASSET_ACCESS_V2:131071:2047:17:11:2:1\n", stderr: "EMBER_ASSET_ACCESS_STDERR_V2\n" },
  { code: 29, stdout: "EMBER_ASSET_ACCESS_V3:32767:131071:15:17:2:1\n", stderr: "EMBER_ASSET_ACCESS_STDERR_V3\n" },
])("V1/V2 or mixed C success cannot satisfy the distinct V3 scope %#", async ({ code, stdout, stderr }) => {
  const { input } = await natural(true, code, { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });
  expect(() => requireWindowsNodeAssetOutputFacts(loaded, input)).toThrow();
});
it.each(["completed", "closed", "run", "launch"] as const)("a structural %s copy cannot certify native asset output", async field => {
  const { input } = await natural(); expect(() => requireWindowsNodeAssetOutputFacts(loaded, { ...input, [field]: { ...input[field] } })).toThrow();
});
it("a genuine closure cannot make altered output, denial counters or another mode pass", async () => {
  const { input } = await natural(true), changed = Buffer.from(input.stdout); changed[28] ^= 1;
  expect(() => requireWindowsNodeAssetOutputFacts(loaded, { ...input, stdout: changed })).toThrow();
  expect(() => requireWindowsNodeAssetOutputFacts(loaded, { ...input, mode: "natural" })).toThrow();
  expect(() => requireWindowsNodeAssetOutputFacts(loaded, { ...input, stderr: Buffer.concat([input.stderr, Buffer.from("x")]) })).toThrow();
});
it.each([39, 401, 402, 403, 404, 405, 406, 407, 408, 409])("projects only the allowlisted genuine C exit %s without relaxing the C success contract", async code => {
  const { input } = await natural(true, code);
  expect(windowsNodeAssetPreludeExit(loaded, input.completed, input.run)).toBe(code);
  if (code !== 39) expect(() => requireWindowsNodeAssetOutputFacts(loaded, input)).toThrow();
});
it.each([0, 1, 17, 19, 29, 200, 205, 210, 300, 305, 310, 0xc0000005])("maps genuine unlisted C exit %s to unknown without exposing it", async code => {
  const { input } = await natural(true, code); expect(windowsNodeAssetPreludeExit(loaded, input.completed, input.run)).toBe(0);
});
it("diagnostic exit projection rejects structural/foreign completion and run references before reading any claimed exit", async () => {
  const { input } = await natural(true), foreign = await natural(true), read = vi.fn(() => { throw Error("PRIVATE claimed native error"); });
  expect(() => windowsNodeAssetPreludeExit(loaded, Object.defineProperty({}, "exitCode", { get: read }), input.run)).toThrow();
  expect(read).not.toHaveBeenCalled();
  expect(() => windowsNodeAssetPreludeExit(loaded, { ...input.completed }, input.run)).toThrow();
  expect(() => windowsNodeAssetPreludeExit(loaded, input.completed, { ...input.run })).toThrow();
  expect(() => windowsNodeAssetPreludeExit(loaded, input.completed, foreign.input.run)).toThrow();
});
const matrixValues = Object.freeze(Array.from({ length: 28 }, (_value, index) => index % 5 + 1));
const unknownProbe = { object: 0, right: 0, outcome: 0, matrix: Array<number>(28).fill(0) };
const tupleFrame = (object = 1, right = 1, outcome = 1) => Buffer.from(`EMBER_ASSET_PROBE_V3:${object}:${right}:${outcome}\n`);
const matrixFrame = (values: readonly number[] = matrixValues) => Buffer.from(`EMBER_ASSET_MATRIX_V3:${values.join("")}\n`);
const probeFrame = (object = 1, right = 1, outcome = 1, matrix: readonly number[] = matrixValues) => Buffer.concat([tupleFrame(object, right, outcome), matrixFrame(matrix)]);
it.each([[1, 1, 1], [8, 3, 5], [5, 4, 1], [6, 4, 5], [7, 4, 2], [8, 4, 3]])("projects only the authenticated closed405 probe tuple %s/%s/%s", async (object, right, outcome) => {
  const { input } = await natural(true, 405, { stdout: Buffer.alloc(0), stderr: probeFrame(object, right, outcome) });
  const probe = windowsNodeAssetPreludeProbe(loaded, input);
  expect(probe).toEqual({ object, right, outcome, matrix: matrixValues }); expect(Object.isFrozen(probe)).toBe(true); expect(Object.isFrozen(probe.matrix)).toBe(true);
  expect(Object.keys(probe).sort()).toEqual(["matrix", "object", "outcome", "right"]);
  expect(() => requireWindowsNodeAssetOutputFacts(loaded, input)).toThrow();
});
it.each([
  ["empty", Buffer.alloc(0)], ["missing newline", Buffer.from("EMBER_ASSET_PROBE_V3:1:1:1")],
  ["CRLF", Buffer.from("EMBER_ASSET_PROBE_V3:1:1:1\r\n")], ["extra newline", Buffer.from("EMBER_ASSET_PROBE_V3:1:1:1\n\n")],
  ["prefix", Buffer.from("xEMBER_ASSET_PROBE_V3:1:1:1\n")], ["suffix", Buffer.from("EMBER_ASSET_PROBE_V3:1:1:1\nx")],
  ["wrong version", Buffer.from(`EMBER_ASSET_PROBE_V2:1:1:1\nEMBER_ASSET_MATRIX_V2:${matrixValues.join("")}\n`)], ["zero object", probeFrame(0)], ["large object", probeFrame(9)],
  ["zero right", probeFrame(1, 0)], ["large right", probeFrame(5, 5)], ["protected object data", probeFrame(1, 4)], ["zero outcome", probeFrame(1, 1, 0)], ["large outcome", probeFrame(1, 1, 6)],
  ["multiple digit", Buffer.from("EMBER_ASSET_PROBE_V3:01:1:1\n")], ["signed digit", Buffer.from("EMBER_ASSET_PROBE_V3:+1:1:1\n")],
  ["space", Buffer.from("EMBER_ASSET_PROBE_V3:1:1:1 \n")], ["NUL", Buffer.from("EMBER_ASSET_PROBE_V3:1:1:1\0\n")],
  ["Unicode digit", Buffer.from("EMBER_ASSET_PROBE_V3:１:1:1\n")],
  ["high ASCII bit", Buffer.from([...probeFrame().subarray(0, -2), 0xb1, 10])],
])("closed405 %s diagnostic bytes project only the zero tuple", async (_name, stderr) => {
  const { input } = await natural(true, 405, { stdout: Buffer.alloc(0), stderr });
  expect(windowsNodeAssetPreludeProbe(loaded, input)).toEqual(unknownProbe);
  expect(() => requireWindowsNodeAssetOutputFacts(loaded, input)).toThrow();
});
it.each([Array<number>(28).fill(1), Array<number>(28).fill(5)].map(matrix => ({ matrix })))("authenticated matrix preserves all twenty-eight boundary enums %#", async ({ matrix }) => {
  const { input } = await natural(true, 405, { stdout: Buffer.alloc(0), stderr: probeFrame(1, 1, 2, matrix) });
  expect(windowsNodeAssetPreludeProbe(loaded, input)).toEqual({ object: 1, right: 1, outcome: 2, matrix });
  expect(() => requireWindowsNodeAssetOutputFacts(loaded, input)).toThrow();
});
it.each(Array.from({ length: 28 }, (_value, index) => index))("an invalid matrix enum at cell %s suppresses the complete diagnostic projection", async cell => {
  const frame = probeFrame(1, 1, 2), offset = tupleFrame().length + Buffer.byteLength("EMBER_ASSET_MATRIX_V3:"); frame[offset + cell] = cell % 2 ? 54 : 48;
  const { input } = await natural(true, 405, { stdout: Buffer.alloc(0), stderr: frame });
  expect(windowsNodeAssetPreludeProbe(loaded, input)).toEqual(unknownProbe);
});
it.each([
  ["tuple only", tupleFrame()], ["matrix only", matrixFrame()], ["reversed frames", Buffer.concat([matrixFrame(), tupleFrame()])],
  ["duplicated matrix", Buffer.concat([probeFrame(), matrixFrame()])], ["short matrix", probeFrame(1, 1, 2, matrixValues.slice(0, 27))],
  ["long matrix", probeFrame(1, 1, 2, [...matrixValues, 1])], ["matrix prefix", Buffer.concat([tupleFrame(), Buffer.from("EMBER_ASSET_MATRIX_V2:123451234512345123\n")])],
  ["matrix CRLF", Buffer.concat([probeFrame().subarray(0, -1), Buffer.from("\r\n")])], ["matrix suffix", Buffer.concat([probeFrame(), Buffer.from("x")])],
])("closed405 %s cannot project either the first tuple or matrix", async (_name, stderr) => {
  const { input } = await natural(true, 405, { stdout: Buffer.alloc(0), stderr }); expect(windowsNodeAssetPreludeProbe(loaded, input)).toEqual(unknownProbe);
});
it("genuine405 closure cannot certify changed supplied counts or nonempty stdout", async () => {
  const { input } = await natural(true, 405, { stdout: Buffer.alloc(0), stderr: probeFrame() });
  for (const stderr of [input.stderr.subarray(0, -1), Buffer.concat([input.stderr, Buffer.from("x")])])
    expect(windowsNodeAssetPreludeProbe(loaded, { ...input, stderr })).toEqual(unknownProbe);
  const withStdout = await natural(true, 405, { stdout: Buffer.from("x"), stderr: probeFrame() });
  expect(windowsNodeAssetPreludeProbe(loaded, withStdout.input)).toEqual(unknownProbe);
});
it("genuine natural39 success never becomes a405 diagnostic tuple", async () => {
  const { input } = await natural(true, 39, { stdout: Buffer.alloc(0), stderr: probeFrame() });
  expect(windowsNodeAssetPreludeProbe(loaded, input)).toEqual(unknownProbe);
  const read = vi.fn(() => { throw Error("PRIVATE non405 bytes"); });
  const forged = Object.defineProperty({ ...input, closed: { ...input.closed } }, "stderr", { get: read });
  expect(() => windowsNodeAssetPreludeProbe(loaded, forged)).toThrow(); expect(read).not.toHaveBeenCalled();
});
it("V1 failure205 and V1 frames remain failures and cannot project a V3 diagnostic", async () => {
  const { input } = await natural(true, 205, { stdout: Buffer.alloc(0), stderr: Buffer.from("EMBER_ASSET_PROBE_V1:1:1:2\nEMBER_ASSET_MATRIX_V1:222122122222111111\n") });
  expect(windowsNodeAssetPreludeExit(loaded, input.completed, input.run)).toBe(0);
  expect(windowsNodeAssetPreludeProbe(loaded, input)).toEqual(unknownProbe);
  expect(() => requireWindowsNodeAssetOutputFacts(loaded, input)).toThrow();
});
it("V2 C305 and complete V2 diagnostic frames remain unknown to V3", async () => {
  const { input } = await natural(true, 305, { stdout: Buffer.alloc(0), stderr: Buffer.from("EMBER_ASSET_PROBE_V2:7:2:1\nEMBER_ASSET_MATRIX_V2:222122122222111111111111\n") });
  expect(windowsNodeAssetPreludeExit(loaded, input.completed, input.run)).toBe(0);
  expect(windowsNodeAssetPreludeProbe(loaded, input)).toEqual(unknownProbe);
  expect(() => requireWindowsNodeAssetOutputFacts(loaded, input)).toThrow();
});
const observation = Object.freeze({ scope: "fixed-test-token-observation" }) as unknown as Parameters<typeof requireWindowsNodeAssetTokenFacts>[1]["observation"];
it("V3 admits the exact Low/integrity-enabled/no-write-up observation while its genuine C launch is still held", async () => {
  const s = outputFake(), copy = await s.prepare(), io = s.owner(); let launch: Parameters<typeof requireWindowsNodeAssetHeldToken>[3] | undefined;
  const read = vi.fn(() => Object.freeze({ integrity: 2, attributes: 2, policy: 1 }));
  const run = await copy.launchRootOnlyWithOutput(context => { launch = io.createSuspended(context, "C:\\trusted\\node.exe", s.command); return launch; },
    () => requireWindowsNodeAssetHeldToken({ requireWindowsCommandOutputLaunch }, { requireTokenObservation: read }, observation, launch!));
  expect(read).toHaveBeenCalledWith(observation, launch); expect(s.events).toContain("resume");
  s.state.ended = true; const completed = await copy.completeRootOnly(run, io.signal); await io.closeOutputAfterStopped(completed, run);
  await copy.close(); closeWindowsCommandCreatorProfile(s.profile);
});
it.each([
  { integrity: 0, attributes: 2, policy: 1 }, { integrity: 3, attributes: 2, policy: 1 },
  { integrity: 2, attributes: 0, policy: 1 }, { integrity: 2, attributes: 1, policy: 1 },
  { integrity: 2, attributes: 2, policy: 0 }, { integrity: 2, attributes: 2, policy: 2 },
  { integrity: 2, attributes: 2, policy: 3 }, { integrity: 2, attributes: 2, policy: 4 },
] as const)("V3 refuses an inadmissible genuine held token before Resume %#", async facts => {
  const s = outputFake(), copy = await s.prepare(), io = s.owner(); let launch: Parameters<typeof requireWindowsNodeAssetHeldToken>[3] | undefined;
  await expect(copy.launchRootOnlyWithOutput(context => { launch = io.createSuspended(context, "C:\\trusted\\node.exe", s.command); return launch; },
    () => requireWindowsNodeAssetHeldToken({ requireWindowsCommandOutputLaunch }, { requireTokenObservation: () => Object.freeze(facts) }, observation, launch!))).rejects.toThrow();
  expect(s.events).toContain("native-create"); expect(s.events).not.toContain("resume");
});
it("V3 held-token admission authenticates the genuine launch before reading observation metadata", () => {
  const read = vi.fn(() => { throw Error("PRIVATE claimed token observation"); });
  const pins = Object.defineProperty({}, "requireTokenObservation", { get: read }) as Parameters<typeof requireWindowsNodeAssetHeldToken>[1];
  expect(() => requireWindowsNodeAssetHeldToken({ requireWindowsCommandOutputLaunch }, pins, observation, {} as Parameters<typeof requireWindowsNodeAssetHeldToken>[3])).toThrow();
  expect(read).not.toHaveBeenCalled();
});
it("token metadata is read only after genuine exact-run completion and output closure", async () => {
  const { input } = await natural(true), facts = Object.freeze({ integrity: 3, attributes: 2, policy: 1 }), read = vi.fn(() => facts);
  expect(requireWindowsNodeAssetTokenFacts(loaded, { ...input, observedRun: input.run, observedLaunch: input.launch, observation, pins: { requireTokenObservation: read } })).toBe(facts);
  expect(read).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledWith(observation, input.launch);
});
it.each(["completed", "closed", "run", "launch"] as const)("token projection rejects structural or foreign %s before consulting observation metadata", async field => {
  const { input } = await natural(true), foreign = await natural(true), read = vi.fn(() => Object.freeze({ integrity: 3, attributes: 2, policy: 1 }));
  for (const value of [{ ...input[field] }, foreign.input[field]]) {
    const projected = Object.defineProperty({ ...input, [field]: value, observedRun: input.run, observedLaunch: input.launch, observation, pins: { requireTokenObservation: read } },
      "observation", { get: () => { throw Error("PRIVATE token observation"); } }) as Parameters<typeof requireWindowsNodeAssetTokenFacts>[1];
    expect(() => requireWindowsNodeAssetTokenFacts(loaded, projected)).toThrow(); expect(read).not.toHaveBeenCalled();
  }
});
it.each(["observedRun", "observedLaunch"] as const)("token projection cannot rebind an observation through a different %s", async field => {
  const { input } = await natural(true), foreign = await natural(true), read = vi.fn(() => Object.freeze({ integrity: 3, attributes: 2, policy: 1 }));
  const projected = { ...input, observedRun: input.run, observedLaunch: input.launch, [field]: field === "observedRun" ? foreign.input.run : foreign.input.launch,
    observation, pins: { requireTokenObservation: read } };
  expect(() => requireWindowsNodeAssetTokenFacts(loaded, projected)).toThrow(); expect(read).not.toHaveBeenCalled();
});
it("token observation failure after genuine shutdown remains a failure without becoming a disposal receipt", async () => {
  const { input } = await natural(true), read = vi.fn(() => { throw Error("Fixed refused token observation."); });
  expect(() => requireWindowsNodeAssetTokenFacts(loaded, { ...input, observedRun: input.run, observedLaunch: input.launch, observation, pins: { requireTokenObservation: read } })).toThrow();
  expect(read).toHaveBeenCalledOnce();
});
it("a token-observation uncertainty thrown by the genuine held attester prevents Resume", async () => {
  const s = outputFake(), copy = await s.prepare(), io = s.owner();
  await expect(copy.launchRootOnlyWithOutput(context => io.createSuspended(context, "C:\\trusted\\node.exe", s.command),
    () => { throw new WindowsNodeAssetEnforcementNativeCleanupError(); })).rejects.toThrow();
  expect(s.events).toContain("native-create"); expect(s.events).not.toContain("resume");
});
it.each(["completed", "closed", "run", "launch"] as const)("probe authentication refuses structural/foreign %s refs before touching stderr", async field => {
  const { input } = await natural(true, 405, { stdout: Buffer.alloc(0), stderr: probeFrame() });
  const foreign = await natural(true, 405, { stdout: Buffer.alloc(0), stderr: probeFrame() });
  const read = vi.fn(() => { throw Error("PRIVATE claimed diagnostic bytes"); });
  for (const value of [{ ...input[field] }, foreign.input[field]]) {
    const claimed = Object.defineProperty({ ...input, [field]: value }, "stderr", { get: read });
    expect(() => windowsNodeAssetPreludeProbe(loaded, claimed)).toThrow();
    expect(read).not.toHaveBeenCalled();
  }
});
it("probe authentication never reads claimed completion or closure getters", async () => {
  const { input } = await natural(true, 405, { stdout: Buffer.alloc(0), stderr: probeFrame() });
  const read = vi.fn(() => { throw Error("PRIVATE claimed native completion"); });
  const claimed = Object.defineProperties({}, { outcome: { get: read }, exitCode: { get: read }, complete: { get: read }, reason: { get: read }, stderrBytes: { get: read } });
  expect(() => windowsNodeAssetPreludeProbe(loaded, { ...input, completed: claimed })).toThrow();
  expect(() => windowsNodeAssetPreludeProbe(loaded, { ...input, closed: claimed })).toThrow();
  expect(read).not.toHaveBeenCalled();
});
it("diagnostic fields are bounded fixed enums and cannot carry raw errors or unlisted exits", () => {
  const supplied = [...matrixValues], known = new WindowsNodeAssetEnforcementObservationError("natural", 4, 11, 405, 3, 3, 3, 5, supplied);
  expect(known).toMatchObject({ phase: 4, preludeStage: 11, cExit: 405, errorClass: 3, probeObject: 3, probeRight: 3, probeOutcome: 5, probeMatrix: matrixValues });
  supplied[0] = 99; expect(known.probeMatrix).toEqual(matrixValues); expect(Object.isFrozen(known.probeMatrix)).toBe(true);
  const unknown = new WindowsNodeAssetEnforcementObservationError("natural", 4, Infinity, 0xc0000005, 99, 9, -1, Infinity);
  expect(unknown).toMatchObject({ preludeStage: 0, cExit: 0, errorClass: 0, probeObject: 0, probeRight: 0, probeOutcome: 0, probeMatrix: Array<number>(28).fill(0) });
  expect(new WindowsNodeAssetEnforcementObservationError("natural", 4, 11, 405, 0, 1, 1, 2, [...matrixValues.slice(0, -1), 99]).probeMatrix).toEqual(unknown.probeMatrix);
  expect(unknown.stack).toBe(`${unknown.name}: ${unknown.message}`);
  const token = new WindowsNodeAssetEnforcementObservationError("natural", 4, 11, 405, 0, 7, 2, 1, [], 1, 3, 2, 0);
  expect(token).toMatchObject({ tokenObserved: 1, tokenIntegrity: 3, tokenAttributes: 2, tokenPolicy: 0 });
  expect(new WindowsNodeAssetEnforcementObservationError("natural", 4, 11, 405, 0, 0, 0, 0, [], 0, 3, 2, 1)).toMatchObject({ tokenObserved: 0, tokenIntegrity: 0, tokenAttributes: 0, tokenPolicy: 0 });
  expect(new WindowsNodeAssetEnforcementObservationError("natural", 4, 11, 405, 0, 0, 0, 0, [], 1, Infinity, 99, 9)).toMatchObject({ tokenObserved: 1, tokenIntegrity: 0, tokenAttributes: 0, tokenPolicy: 0 });
});
it("diagnostic error classes require the exact constructors and never coerce claimed names, messages or causes", () => {
  const classes = { WindowsRootOnlyCommandCopyCleanupError, WindowsCommandCopyCleanupError, WindowsCommandRootOnlyCleanupError, WindowsCommandOutputCleanupError,
    WindowsCommandCreatorProfileCleanupError, WindowsCommandCopyProofCleanupError, WindowsNodeAssetEnforcementNativeCleanupError, WindowsNodeToolchainCleanupError };
  Object.values(classes).forEach((type, index) => expect(windowsNodeAssetErrorClass(classes, new type())).toBe(index + 1));
  const read = vi.fn(() => { throw Error("PRIVATE raw native message"); });
  const claimed = Object.defineProperties({}, { name: { get: read }, message: { get: read }, cause: { get: read }, toString: { value: read } });
  expect(windowsNodeAssetErrorClass(classes, claimed)).toBe(0); expect(read).not.toHaveBeenCalled();
  expect(windowsNodeAssetErrorClass(classes, new Error("WindowsCommandOutputCleanupError"))).toBe(0);
  expect(windowsNodeAssetErrorClass(classes, new (class WindowsCommandOutputCleanupError extends Error {})())).toBe(0);
  expect(windowsNodeAssetErrorClass(undefined, new WindowsCommandOutputCleanupError())).toBe(0);
  expect(windowsNodeAssetErrorClass(classes, new Proxy({}, { getPrototypeOf: read }))).toBe(0);
});
it("the prelude stage schedule authenticates completed/run before projecting C exit and preserves close/Stop/facts ordering", () => {
  const source = fs.readFileSync(new URL("../fixtures/windows-node-asset-enforcement-proof.ts", import.meta.url), "utf8");
  const prelude = source.slice(source.indexOf('if (mode === "natural" || mode === "natural-default") {', source.indexOf("const checkControlBytes =")), source.indexOf("phase = 5; verified()"));
  expect([...prelude.matchAll(/preludeStage = (\d+);/g)].map(match => Number(match[1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  expect(prelude).toContain("preludeStage = 7; const done = await copy.completeRootOnly(run, io.signal)");
  expect(prelude).toContain("preludeStage = 8; cExit = windowsNodeAssetPreludeExit(loaded, done, run)");
  expect(prelude).toContain("preludeStage = 9; const closed = await io.closeOutputAfterStopped(done, run)");
  const stopped = prelude.indexOf("preludeStage = 10; authenticateStop(1);");
  const token = prelude.indexOf("tokenFacts = native(() => requireWindowsNodeAssetTokenFacts(loaded!");
  const probe = prelude.indexOf("probe = windowsNodeAssetPreludeProbe(loaded, { completed: done, closed, run, launch: launch!, stderr: failureBytes })");
  const facts = prelude.indexOf('preludeStage = 11; facts("prelude", done, closed, run)');
  expect(stopped).toBeGreaterThan(-1); expect(token).toBeGreaterThan(stopped); expect(probe).toBeGreaterThan(token); expect(facts).toBeGreaterThan(probe);
  expect(prelude).toContain("finally { failureBytes.fill(0); }");
  const observed = prelude.indexOf("heldToken = Object.freeze({ ref:");
  const admitted = prelude.indexOf("requireWindowsNodeAssetHeldToken(loaded!, targetPins!, heldToken!.ref, launch!)");
  expect(admitted).toBeGreaterThan(observed); expect(admitted).toBeLessThan(prelude.indexOf("preludeStage = 5;"));
  expect(prelude.indexOf("checkControlBytes();")).toBeLessThan(prelude.indexOf("copy.launchRootOnlyWithOutput"));
  expect(prelude.indexOf("preludeStage = 12; checkControlBytes();")).toBeGreaterThan(stopped);
  const control = source.slice(source.indexOf("const checkControlBytes ="), source.indexOf("copy = await loaded.WindowsRootOnlyCommandCopy.create"));
  expect(control).toContain("proof!.pin(file, 20)"); expect(control).toContain('bytes.equals(Buffer.from("EMBER_ASSET_CONTROL\\n"))');
  expect(control.indexOf("bytes.fill(0)")).toBeLessThan(control.indexOf("pin.close()"));
  expect(control.indexOf("pin.close()")).toBeLessThan(control.indexOf("controlReaders.pop()"));
});
it.each(["cancel", "overflow"] as const)("fixed %s bytes require genuine automatic Stop and incomplete closed output", async mode => {
  const s = outputFake(), v = await s.launch(); chunks(s, 0, Buffer.from(NODE_ASSET_READY)); chunks(s, 1, Buffer.from(NODE_ASSET_ERROR_READY));
  await until(() => s.output.length >= 2);
  if (mode === "cancel") s.abort.abort(); else for (let index = 0; index < 32; index++) chunks(s, 0, Buffer.alloc(16384, 88));
  await until(() => s.events.includes("stop-root") && s.events.includes("stop-job"));
  const completed = await v.copy.completeRootOnly(v.run, v.io.signal), closed = await v.io.closeOutputAfterStopped(completed, v.run);
  const stdout = Buffer.concat(s.output.filter(item => item.stream === "stdout").map(item => item.bytes)), stderr = Buffer.concat(s.output.filter(item => item.stream === "stderr").map(item => item.bytes));
  const input = { mode, completed, closed, run: v.run, launch: v.ref, stdout, stderr };
  expect(windowsNodeAssetPreludeExit(loaded, completed, v.run)).toBe(0);
  expect(windowsNodeAssetPreludeProbe(loaded, input)).toEqual(unknownProbe);
  expect(requireWindowsNodeAssetOutputFacts(loaded, input)).toMatchObject({ exitCode: null, complete: false, reason: mode === "overflow" ? "overflow" : "cancelled" });
  if (mode === "overflow") { const changed = Buffer.from(stdout); changed[changed.length - 1] = 89; expect(() => requireWindowsNodeAssetOutputFacts(loaded, { ...input, stdout: changed })).toThrow(); }
  await v.copy.close(); closeWindowsCommandCreatorProfile(s.profile);
});
it("observes the exact genuine Stop promise only after its same-binding opaque receipt authenticates", async () => {
  const binding = Object.freeze({}), seen: unknown[] = [], api = { createJob: () => 71n, terminateJob: vi.fn(), terminateProcess: vi.fn() } as unknown as WindowsLpacApi;
  const real = createWindowsCommandRootOnlyStopOwner(binding, api, { configure() {}, assertLimits() {}, state: () => ({ total: 0, active: 0, pids: [] }), wait: () => 0, close() {}, processId: () => 1, threadProcessId: () => 1, member: () => false }, () => 1, { retained: [] });
  const observed = observeWindowsNodeAssetStop(real, binding, requireWindowsCommandRootOnlyStopped, ref => seen.push(ref));
  const pending = observed.stop(), original = real.stop(); expect(pending).toBe(original); expect(seen).toEqual([]);
  const ref = await pending; await Promise.resolve(); expect(seen).toEqual([ref]); expect(() => requireWindowsCommandRootOnlyStopped(ref, {})).toThrow();
});
it("callback-shaped Stop returns cannot reach the observed receipt path", async () => {
  const seen = vi.fn(), owner = { scope: "root-only", stop: () => Promise.resolve({ scope: "root-only" }) } as unknown as WindowsCommandRootOnlyStopOwner;
  await observeWindowsNodeAssetStop(owner, {}, requireWindowsCommandRootOnlyStopped, seen).stop(); await Promise.resolve(); expect(seen).not.toHaveBeenCalled();
});
it("first source/loader failure permanently closes the private observer before another loader/native entry", async () => {
  const load = vi.fn(() => { throw Error("PRIVATE source location"); }), observe = bindWindowsNodeAssetEnforcement({ load });
  const input = { executable: "relative", module: "relative", program: "relative" };
  const first = await observe(input, () => undefined, "relative", "relative", "natural").catch(error => error);
  expect(first).toBeInstanceOf(WindowsNodeAssetEnforcementObservationError); expect(first).toMatchObject({ phase: 1, preludeStage: 0, cExit: 0, errorClass: 0 });
  expect(String(first)).not.toContain("PRIVATE"); expect(load).not.toHaveBeenCalled();
  expect(await observe(input, () => undefined, "relative", "relative", "cancel").catch(error => error)).toBe(first);
});
it("the default-Medium fixture creates an empty protected ancestor SACL and genuinely unlabeled borrowed parent without weakening its DACL", () => {
  const owner = "S-1-5-21-1-2-3-1000", packageSid = "S-1-15-2-123-456-789-10-11-12-13";
  const explicit = windowsNodeAssetCreationSecurity(owner, packageSid, "natural"), implicit = windowsNodeAssetCreationSecurity(owner, packageSid, "natural-default");
  expect(explicit.privateParent).toContain("S:(ML;OICI;NW;;;ME)"); expect(implicit.privateParent).not.toContain("S:");
  expect(implicit.directory).toMatch(/S:P$/); expect(implicit.directory).not.toContain("ML;");
  const dacl = (value: string) => value.slice(value.indexOf("D:"), value.includes("S:") ? value.indexOf("S:") : value.length);
  expect(dacl(implicit.privateParent)).toBe(dacl(implicit.lowOwner)); expect(dacl(explicit.privateParent)).toBe(dacl(implicit.privateParent));
  expect(implicit.lowOwner).toContain("S:(ML;OICI;NW;;;LW)"); expect(implicit.privateParent).not.toContain(packageSid);
  expect(implicit.lowFullDirectory).toContain(`(A;OICI;FA;;;${packageSid})`); expect(implicit.lowFullFile).toContain(`(A;;FA;;;${packageSid})`);
  expect(dacl(implicit.mediumFullDirectory)).toBe(dacl(implicit.lowFullDirectory)); expect(dacl(implicit.mediumFullFile)).toBe(dacl(implicit.lowFullFile));
  expect(implicit.mediumFullDirectory).toContain("S:(ML;OICI;NW;;;ME)"); expect(implicit.mediumFullFile).toContain("S:(ML;;NW;;;ME)");
  expect(() => windowsNodeAssetCreationSecurity("S-1-5-18", packageSid, "natural-default")).toThrow();
});
