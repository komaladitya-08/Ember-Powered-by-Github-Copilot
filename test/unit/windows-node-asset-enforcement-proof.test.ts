import { expect, it, vi } from "vitest";
import fs from "node:fs";
import { runInNewContext } from "node:vm";
import { outputFake } from "../fixtures/windows-command-output-fake";
import { requireWindowsCommandRootOnlyCompleted, WindowsRootOnlyCommandCopy, WindowsRootOnlyCommandCopyCleanupError } from "../../app/main/agent/windows-command-copy";
import { requireWindowsCommandOutputClosed, requireWindowsCommandOutputLaunch, WindowsCommandOutputCleanupError } from "../../app/main/agent/windows-command-output";
import { closeWindowsCommandCreatorProfile, windowsCommandCreatorProfile, WindowsCommandCreatorProfileCleanupError } from "../../app/main/agent/windows-command-creator-profile";
import { createWindowsCommandRootOnlyStopOwner, requireWindowsCommandRootOnlyStopped, requireWindowsCommandRootOnlyAttestingCurrent, windowsCommandRootOnlyFailure, WindowsCommandRootOnlyCleanupError, type WindowsCommandRootOnlyStopOwner } from "../../app/main/agent/windows-command-stop";
import { WindowsCommandCopyCleanupError } from "../../app/main/agent/windows-command-copy-native";
import { WindowsNodeToolchainCleanupError } from "../../app/main/agent/windows-node-toolchain-native";
import { bindWindowsCommandCopyProofNative, WindowsCommandCopyProofCleanupError } from "../fixtures/windows-command-copy-proof-native";
import { WindowsNodeAssetEnforcementNativeCleanupError } from "../fixtures/windows-node-asset-enforcement-native";
import { bindWindowsNodeAssetEnforcement, observeWindowsNodeAssetStop, observeWindowsNodeAssetNodeCall, observeWindowsNodeAssetPreparation, windowsNodeAssetPreparationNativeFailure, windowsNodeAssetLaunchObservation, requireWindowsNodeAssetOutputFacts,
  windowsNodeAssetCreationSecurity, windowsNodeAssetPreludeExit, windowsNodeAssetPreludeProbe, windowsNodeAssetErrorClass, requireWindowsNodeAssetHeldToken, requireWindowsNodeAssetTokenFacts, NODE_ASSET_READY, NODE_ASSET_ERROR_READY, WindowsNodeAssetEnforcementObservationError } from "../fixtures/windows-node-asset-enforcement-proof";
import type { WindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";

const loaded = { requireWindowsCommandRootOnlyCompleted, requireWindowsCommandOutputClosed };
const diagnosticClasses = { WindowsRootOnlyCommandCopyCleanupError, WindowsCommandCopyCleanupError, WindowsCommandRootOnlyCleanupError, WindowsCommandOutputCleanupError,
  WindowsCommandCreatorProfileCleanupError, WindowsCommandCopyProofCleanupError, WindowsNodeAssetEnforcementNativeCleanupError, WindowsNodeToolchainCleanupError };
const launchReaders = { ...diagnosticClasses, windowsCommandRootOnlyFailure };
function actualStopFixture() {
  const binding = Object.freeze({}), events: string[] = [], state = { assigned: false, ended: false };
  const api = { createJob: () => 901n, assign() { state.assigned = true; }, resume() { events.push("resume"); },
    terminateProcess() { state.ended = true; }, terminateJob() { state.ended = true; } } as unknown as WindowsLpacApi;
  const native = { configure() {}, assertLimits() {}, state: () => ({ total: state.assigned ? 1 : 0, active: state.assigned && !state.ended ? 1 : 0, pids: state.assigned && !state.ended ? [31] : [] }),
    processId: () => 31, threadProcessId: () => 31, member: () => state.assigned, wait: (): 0 => 0, close() { events.push("close"); } };
  const fence = { retained: [] as unknown[] }, real = createWindowsCommandRootOnlyStopOwner(binding, api, native, () => 1, fence);
  const create = () => ({ process: 902n, thread: 903n, pid: 31 });
  return { binding, events, state, fence, real, create };
}
const until = async (check: () => boolean) => { const deadline = performance.now() + 4000; while (!check()) { if (performance.now() > deadline) throw Error("Fixed portable asset deadline."); await new Promise<void>(resolve => setTimeout(resolve, 5)); } };
const chunks = (s: ReturnType<typeof outputFake>, stream: number, bytes: Buffer) => { for (let at = 0; at < bytes.length; at += 16384) s.enqueue(stream, bytes.subarray(at, at + 16384)); };
async function natural(prelude = false, exitCode = prelude ? 49 : 17, frames?: { stdout?: Buffer; stderr?: Buffer }) {
  const s = outputFake(), v = await s.launch(); s.state.code = exitCode;
  const stdout = frames?.stdout ?? (prelude ? Buffer.from("EMBER_ASSET_ACCESS_V4:524287:8191:19:13:2:1\n") : Buffer.concat([Buffer.from(NODE_ASSET_READY), Buffer.alloc(73728, 79), Buffer.from("\nEMBER_NODE_ASSET_DONE\n")]));
  const stderr = frames?.stderr ?? (prelude ? Buffer.from("EMBER_ASSET_ACCESS_STDERR_V4\n") : Buffer.concat([Buffer.from(NODE_ASSET_ERROR_READY), Buffer.alloc(67584, 69), Buffer.from("\nEMBER_NODE_ASSET_STDERR_DONE\n")]));
  chunks(s, 0, stdout); chunks(s, 1, stderr); s.state.ended = true;
  const completed = await v.copy.completeRootOnly(v.run, v.io.signal), closed = await v.io.closeOutputAfterStopped(completed, v.run);
  await v.copy.close(); closeWindowsCommandCreatorProfile(s.profile);
  return { s, input: { mode: prelude ? "prelude" as const : "natural" as const, completed, closed, run: v.run, launch: v.ref, stdout, stderr } };
}
it.each([false, true])("fixed genuine natural/C access output requires real closed exact-run references %#", async prelude => {
  const { s, input } = await natural(prelude);
  expect(requireWindowsNodeAssetOutputFacts(loaded, input)).toMatchObject({ exitCode: prelude ? 49 : 17, reason: "none", complete: true });
  expect([...s.handles.values()].every(handle => handle.closed)).toBe(true); expect([...s.allocations.values()].every(allocation => allocation.freed)).toBe(true);
});
it.each([
  { code: 19, stdout: "EMBER_ASSET_ACCESS_V1:255:511:1\n", stderr: "EMBER_ASSET_ACCESS_STDERR\n" },
  { code: 49, stdout: "EMBER_ASSET_ACCESS_V1:255:511:1\n", stderr: "EMBER_ASSET_ACCESS_STDERR\n" },
  { code: 19, stdout: "EMBER_ASSET_ACCESS_V4:524287:8191:19:13:2:1\n", stderr: "EMBER_ASSET_ACCESS_STDERR_V4\n" },
  { code: 29, stdout: "EMBER_ASSET_ACCESS_V2:131071:2047:17:11:2:1\n", stderr: "EMBER_ASSET_ACCESS_STDERR_V2\n" },
  { code: 49, stdout: "EMBER_ASSET_ACCESS_V2:131071:2047:17:11:2:1\n", stderr: "EMBER_ASSET_ACCESS_STDERR_V2\n" },
  { code: 29, stdout: "EMBER_ASSET_ACCESS_V4:524287:8191:19:13:2:1\n", stderr: "EMBER_ASSET_ACCESS_STDERR_V4\n" },
  { code: 39, stdout: "EMBER_ASSET_ACCESS_V3:32767:131071:15:17:2:1\n", stderr: "EMBER_ASSET_ACCESS_STDERR_V3\n" },
  { code: 49, stdout: "EMBER_ASSET_ACCESS_V3:32767:131071:15:17:2:1\n", stderr: "EMBER_ASSET_ACCESS_STDERR_V3\n" },
  { code: 39, stdout: "EMBER_ASSET_ACCESS_V4:524287:8191:19:13:2:1\n", stderr: "EMBER_ASSET_ACCESS_STDERR_V4\n" },
])("V1/V2/V3 or mixed C success cannot satisfy the distinct V4 scope %#", async ({ code, stdout, stderr }) => {
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
it.each([49, 501, 502, 503, 504, 505, 506, 507, 508, 509])("projects only the allowlisted genuine C exit %s without relaxing the C success contract", async code => {
  const { input } = await natural(true, code);
  expect(windowsNodeAssetPreludeExit(loaded, input.completed, input.run)).toBe(code);
  if (code !== 49) expect(() => requireWindowsNodeAssetOutputFacts(loaded, input)).toThrow();
});
it.each([0, 1, 17, 19, 29, 39, 200, 205, 210, 300, 305, 310, 405, 0xc0000005])("maps genuine unlisted C exit %s to unknown without exposing it", async code => {
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
const tupleFrame = (object = 1, right = 1, outcome = 1) => Buffer.from(`EMBER_ASSET_PROBE_V4:${object}:${right}:${outcome}\n`);
const matrixFrame = (values: readonly number[] = matrixValues) => Buffer.from(`EMBER_ASSET_MATRIX_V4:${values.join("")}\n`);
const probeFrame = (object = 1, right = 1, outcome = 1, matrix: readonly number[] = matrixValues) => Buffer.concat([tupleFrame(object, right, outcome), matrixFrame(matrix)]);
it.each([[1, 1, 1], [8, 3, 5], [5, 4, 1], [6, 4, 5], [7, 4, 2], [8, 4, 3]])("projects only the authenticated closed505 probe tuple %s/%s/%s", async (object, right, outcome) => {
  const { input } = await natural(true, 505, { stdout: Buffer.alloc(0), stderr: probeFrame(object, right, outcome) });
  const probe = windowsNodeAssetPreludeProbe(loaded, input);
  expect(probe).toEqual({ object, right, outcome, matrix: matrixValues }); expect(Object.isFrozen(probe)).toBe(true); expect(Object.isFrozen(probe.matrix)).toBe(true);
  expect(Object.keys(probe).sort()).toEqual(["matrix", "object", "outcome", "right"]);
  expect(() => requireWindowsNodeAssetOutputFacts(loaded, input)).toThrow();
});
it.each([
  ["empty", Buffer.alloc(0)], ["missing newline", Buffer.from("EMBER_ASSET_PROBE_V4:1:1:1")],
  ["CRLF", Buffer.from("EMBER_ASSET_PROBE_V4:1:1:1\r\n")], ["extra newline", Buffer.from("EMBER_ASSET_PROBE_V4:1:1:1\n\n")],
  ["prefix", Buffer.from("xEMBER_ASSET_PROBE_V4:1:1:1\n")], ["suffix", Buffer.from("EMBER_ASSET_PROBE_V4:1:1:1\nx")],
  ["wrong version", Buffer.from(`EMBER_ASSET_PROBE_V2:1:1:1\nEMBER_ASSET_MATRIX_V2:${matrixValues.join("")}\n`)], ["zero object", probeFrame(0)], ["large object", probeFrame(9)],
  ["zero right", probeFrame(1, 0)], ["large right", probeFrame(5, 5)], ["protected object data", probeFrame(1, 4)], ["zero outcome", probeFrame(1, 1, 0)], ["large outcome", probeFrame(1, 1, 6)],
  ["multiple digit", Buffer.from("EMBER_ASSET_PROBE_V4:01:1:1\n")], ["signed digit", Buffer.from("EMBER_ASSET_PROBE_V4:+1:1:1\n")],
  ["space", Buffer.from("EMBER_ASSET_PROBE_V4:1:1:1 \n")], ["NUL", Buffer.from("EMBER_ASSET_PROBE_V4:1:1:1\0\n")],
  ["Unicode digit", Buffer.from("EMBER_ASSET_PROBE_V4:１:1:1\n")],
  ["high ASCII bit", Buffer.from([...probeFrame().subarray(0, -2), 0xb1, 10])],
])("closed505 %s diagnostic bytes project only the zero tuple", async (_name, stderr) => {
  const { input } = await natural(true, 505, { stdout: Buffer.alloc(0), stderr });
  expect(windowsNodeAssetPreludeProbe(loaded, input)).toEqual(unknownProbe);
  expect(() => requireWindowsNodeAssetOutputFacts(loaded, input)).toThrow();
});
it.each([Array<number>(28).fill(1), Array<number>(28).fill(5)].map(matrix => ({ matrix })))("authenticated matrix preserves all twenty-eight boundary enums %#", async ({ matrix }) => {
  const { input } = await natural(true, 505, { stdout: Buffer.alloc(0), stderr: probeFrame(1, 1, 2, matrix) });
  expect(windowsNodeAssetPreludeProbe(loaded, input)).toEqual({ object: 1, right: 1, outcome: 2, matrix });
  expect(() => requireWindowsNodeAssetOutputFacts(loaded, input)).toThrow();
});
it.each(Array.from({ length: 28 }, (_value, index) => index))("an invalid matrix enum at cell %s suppresses the complete diagnostic projection", async cell => {
  const frame = probeFrame(1, 1, 2), offset = tupleFrame().length + Buffer.byteLength("EMBER_ASSET_MATRIX_V4:"); frame[offset + cell] = cell % 2 ? 54 : 48;
  const { input } = await natural(true, 505, { stdout: Buffer.alloc(0), stderr: frame });
  expect(windowsNodeAssetPreludeProbe(loaded, input)).toEqual(unknownProbe);
});
it.each([
  ["tuple only", tupleFrame()], ["matrix only", matrixFrame()], ["reversed frames", Buffer.concat([matrixFrame(), tupleFrame()])],
  ["duplicated matrix", Buffer.concat([probeFrame(), matrixFrame()])], ["short matrix", probeFrame(1, 1, 2, matrixValues.slice(0, 27))],
  ["long matrix", probeFrame(1, 1, 2, [...matrixValues, 1])], ["matrix prefix", Buffer.concat([tupleFrame(), Buffer.from("EMBER_ASSET_MATRIX_V2:123451234512345123\n")])],
  ["matrix CRLF", Buffer.concat([probeFrame().subarray(0, -1), Buffer.from("\r\n")])], ["matrix suffix", Buffer.concat([probeFrame(), Buffer.from("x")])],
])("closed505 %s cannot project either the first tuple or matrix", async (_name, stderr) => {
  const { input } = await natural(true, 505, { stdout: Buffer.alloc(0), stderr }); expect(windowsNodeAssetPreludeProbe(loaded, input)).toEqual(unknownProbe);
});
it("genuine505 closure cannot certify changed supplied counts or nonempty stdout", async () => {
  const { input } = await natural(true, 505, { stdout: Buffer.alloc(0), stderr: probeFrame() });
  for (const stderr of [input.stderr.subarray(0, -1), Buffer.concat([input.stderr, Buffer.from("x")])])
    expect(windowsNodeAssetPreludeProbe(loaded, { ...input, stderr })).toEqual(unknownProbe);
  const withStdout = await natural(true, 505, { stdout: Buffer.from("x"), stderr: probeFrame() });
  expect(windowsNodeAssetPreludeProbe(loaded, withStdout.input)).toEqual(unknownProbe);
});
it("genuine natural49 success never becomes a505 diagnostic tuple", async () => {
  const { input } = await natural(true, 49, { stdout: Buffer.alloc(0), stderr: probeFrame() });
  expect(windowsNodeAssetPreludeProbe(loaded, input)).toEqual(unknownProbe);
  const read = vi.fn(() => { throw Error("PRIVATE non505 bytes"); });
  const forged = Object.defineProperty({ ...input, closed: { ...input.closed } }, "stderr", { get: read });
  expect(() => windowsNodeAssetPreludeProbe(loaded, forged)).toThrow(); expect(read).not.toHaveBeenCalled();
});
it("V1 failure205 and V1 frames remain failures and cannot project a V4 diagnostic", async () => {
  const { input } = await natural(true, 205, { stdout: Buffer.alloc(0), stderr: Buffer.from("EMBER_ASSET_PROBE_V1:1:1:2\nEMBER_ASSET_MATRIX_V1:222122122222111111\n") });
  expect(windowsNodeAssetPreludeExit(loaded, input.completed, input.run)).toBe(0);
  expect(windowsNodeAssetPreludeProbe(loaded, input)).toEqual(unknownProbe);
  expect(() => requireWindowsNodeAssetOutputFacts(loaded, input)).toThrow();
});
it("V2 C305 and complete V2 diagnostic frames remain unknown to V4", async () => {
  const { input } = await natural(true, 305, { stdout: Buffer.alloc(0), stderr: Buffer.from("EMBER_ASSET_PROBE_V2:7:2:1\nEMBER_ASSET_MATRIX_V2:222122122222111111111111\n") });
  expect(windowsNodeAssetPreludeExit(loaded, input.completed, input.run)).toBe(0);
  expect(windowsNodeAssetPreludeProbe(loaded, input)).toEqual(unknownProbe);
  expect(() => requireWindowsNodeAssetOutputFacts(loaded, input)).toThrow();
});
it("V3 C405 and complete V3 frames cannot project V4 diagnostics or success", async () => {
  const { input } = await natural(true, 405, { stdout: Buffer.alloc(0), stderr: Buffer.from("EMBER_ASSET_PROBE_V3:7:4:1\nEMBER_ASSET_MATRIX_V3:2221221222221111111111111111\n") });
  expect(windowsNodeAssetPreludeExit(loaded, input.completed, input.run)).toBe(0);
  expect(windowsNodeAssetPreludeProbe(loaded, input)).toEqual(unknownProbe);
  expect(() => requireWindowsNodeAssetOutputFacts(loaded, input)).toThrow();
});
const observation = Object.freeze({ scope: "fixed-test-token-observation" }) as unknown as Parameters<typeof requireWindowsNodeAssetTokenFacts>[1]["observation"];
it("V4 admits the exact Low/integrity-enabled/no-write-up observation while its genuine C launch is still held", async () => {
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
] as const)("V4 refuses an inadmissible genuine held token before Resume %#", async facts => {
  const s = outputFake(), copy = await s.prepare(), io = s.owner(); let launch: Parameters<typeof requireWindowsNodeAssetHeldToken>[3] | undefined;
  await expect(copy.launchRootOnlyWithOutput(context => { launch = io.createSuspended(context, "C:\\trusted\\node.exe", s.command); return launch; },
    () => requireWindowsNodeAssetHeldToken({ requireWindowsCommandOutputLaunch }, { requireTokenObservation: () => Object.freeze(facts) }, observation, launch!))).rejects.toThrow();
  expect(s.events).toContain("native-create"); expect(s.events).not.toContain("resume");
});
it("V4 held-token admission authenticates the genuine launch before reading observation metadata", () => {
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
  const { input } = await natural(true, 505, { stdout: Buffer.alloc(0), stderr: probeFrame() });
  const foreign = await natural(true, 505, { stdout: Buffer.alloc(0), stderr: probeFrame() });
  const read = vi.fn(() => { throw Error("PRIVATE claimed diagnostic bytes"); });
  for (const value of [{ ...input[field] }, foreign.input[field]]) {
    const claimed = Object.defineProperty({ ...input, [field]: value }, "stderr", { get: read });
    expect(() => windowsNodeAssetPreludeProbe(loaded, claimed)).toThrow();
    expect(read).not.toHaveBeenCalled();
  }
});
it("probe authentication never reads claimed completion or closure getters", async () => {
  const { input } = await natural(true, 505, { stdout: Buffer.alloc(0), stderr: probeFrame() });
  const read = vi.fn(() => { throw Error("PRIVATE claimed native completion"); });
  const claimed = Object.defineProperties({}, { outcome: { get: read }, exitCode: { get: read }, complete: { get: read }, reason: { get: read }, stderrBytes: { get: read } });
  expect(() => windowsNodeAssetPreludeProbe(loaded, { ...input, completed: claimed })).toThrow();
  expect(() => windowsNodeAssetPreludeProbe(loaded, { ...input, closed: claimed })).toThrow();
  expect(read).not.toHaveBeenCalled();
});
it("diagnostic fields are bounded fixed enums and cannot carry raw errors or unlisted exits", () => {
  const supplied = [...matrixValues], known = new WindowsNodeAssetEnforcementObservationError("natural", 4, 11, 505, 3, 3, 3, 5, supplied);
  expect(known).toMatchObject({ phase: 4, preludeStage: 11, cExit: 505, errorClass: 3, probeObject: 3, probeRight: 3, probeOutcome: 5, probeMatrix: matrixValues });
  supplied[0] = 99; expect(known.probeMatrix).toEqual(matrixValues); expect(Object.isFrozen(known.probeMatrix)).toBe(true);
  const unknown = new WindowsNodeAssetEnforcementObservationError("natural", 4, Infinity, 0xc0000005, 99, 9, -1, Infinity);
  expect(unknown).toMatchObject({ preludeStage: 0, cExit: 0, errorClass: 0, probeObject: 0, probeRight: 0, probeOutcome: 0, probeMatrix: Array<number>(28).fill(0) });
  expect(new WindowsNodeAssetEnforcementObservationError("natural", 4, 11, 505, 0, 1, 1, 2, [...matrixValues.slice(0, -1), 99]).probeMatrix).toEqual(unknown.probeMatrix);
  expect(unknown.stack).toBe(`${unknown.name}: ${unknown.message}`);
  const token = new WindowsNodeAssetEnforcementObservationError("natural", 4, 11, 505, 0, 7, 2, 1, [], 1, 3, 2, 0);
  expect(token).toMatchObject({ tokenObserved: 1, tokenIntegrity: 3, tokenAttributes: 2, tokenPolicy: 0 });
  expect(new WindowsNodeAssetEnforcementObservationError("natural", 4, 11, 505, 0, 0, 0, 0, [], 0, 3, 2, 1)).toMatchObject({ tokenObserved: 0, tokenIntegrity: 0, tokenAttributes: 0, tokenPolicy: 0 });
  expect(new WindowsNodeAssetEnforcementObservationError("natural", 4, 11, 505, 0, 0, 0, 0, [], 1, Infinity, 99, 9)).toMatchObject({ tokenObserved: 1, tokenIntegrity: 0, tokenAttributes: 0, tokenPolicy: 0 });
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
it.each(Object.values(diagnosticClasses).map((type, index) => ({ type, kind: index + 1 })))("Node observation preserves the identical class$kind failure and calls its operation once", ({ type, kind }) => {
  const state = { checkpoint: 1, innerClass: 0 }, original = new type(), operation = vi.fn(() => { throw original; }); let caught: unknown;
  try { observeWindowsNodeAssetNodeCall(diagnosticClasses, state, 2, 3, operation); } catch (error) { caught = error; }
  expect(caught).toBe(original); expect(operation).toHaveBeenCalledOnce(); expect(state).toEqual({ checkpoint: 2, innerClass: kind });
});
it("Node observation reads no claimed error properties and preserves an unclassified thrown value", () => {
  const read = vi.fn(() => { throw Error("PRIVATE claimed Node error"); });
  const original = Object.defineProperties({}, Object.fromEntries(["name", "message", "code", "cause", "stack"].map(key => [key, { get: read }])));
  const state = { checkpoint: 1, innerClass: 0 }; let caught: unknown;
  try { observeWindowsNodeAssetNodeCall(diagnosticClasses, state, 4, 5, () => { throw original; }); } catch (error) { caught = error; }
  expect(caught).toBe(original); expect(read).not.toHaveBeenCalled(); expect(state).toEqual({ checkpoint: 4, innerClass: 0 });
});
it("a failed diagnostic classification cannot replace the original Node error", () => {
  const original = new Error("Fixed original failure."), state = { checkpoint: 1, innerClass: 0 };
  const classes = Object.defineProperty({ ...diagnosticClasses }, "WindowsRootOnlyCommandCopyCleanupError", { get: () => { throw Error("PRIVATE classifier failure"); } });
  let caught: unknown; try { observeWindowsNodeAssetNodeCall(classes, state, 5, 6, () => { throw original; }); } catch (error) { caught = error; }
  expect(caught).toBe(original); expect(state).toEqual({ checkpoint: 5, innerClass: 0 });
});
it("diagnostic storage cannot change the original return or throw", () => {
  const state = Object.freeze({ checkpoint: 0, innerClass: 0 }), result = Object.freeze({}), original = new WindowsNodeToolchainCleanupError();
  expect(observeWindowsNodeAssetNodeCall(diagnosticClasses, state, 2, 3, () => result)).toBe(result);
  let caught: unknown; try { observeWindowsNodeAssetNodeCall(diagnosticClasses, state, 2, 3, () => { throw original; }); } catch (error) { caught = error; }
  expect(caught).toBe(original); expect(state).toEqual({ checkpoint: 0, innerClass: 0 });
});
it.each(Object.values(diagnosticClasses).map((type, index) => ({ type, kind: index + 1 })))("preparation observes original class$kind before the existing proof guard wraps it", ({ type, kind }) => {
  const proof = bindWindowsCommandCopyProofNative(() => ({ func: () => () => undefined }));
  const state = { operation: 0, object: 0, innerClass: 0, nativeFailure: 0 }, original = new type(), action = vi.fn(() => { throw original; });
  let inner: unknown;
  expect(() => proof.guard(() => {
    try { return observeWindowsNodeAssetPreparation(diagnosticClasses, state, 5, 1, action); }
    catch (error) { inner = error; throw error; }
  })).toThrow(WindowsCommandCopyProofCleanupError);
  expect(inner).toBe(original); expect(action).toHaveBeenCalledOnce(); expect(state).toEqual({ operation: 5, object: 1, innerClass: kind, nativeFailure: 0 });
  expect(proof.unsafe).toBe(true); const later = vi.fn(); expect(() => proof.guard(later)).toThrow(WindowsCommandCopyProofCleanupError); expect(later).not.toHaveBeenCalled();
});
it("preparation returns the exact value with one original guard/callback and preserves the callback's receiver", () => {
  const proof = bindWindowsCommandCopyProofNative(() => ({ func: () => () => undefined })), guard = vi.spyOn(proof, "guard");
  const state = { operation: 0, object: 0, innerClass: 8, nativeFailure: 4 }, expected = Object.freeze({}), target = { call: vi.fn(() => expected) };
  expect(proof.guard(() => observeWindowsNodeAssetPreparation(diagnosticClasses, state, 6, 7, () => target.call()))).toBe(expected);
  expect(guard).toHaveBeenCalledOnce(); expect(target.call).toHaveBeenCalledOnce(); expect(target.call.mock.contexts[0]).toBe(target);
  expect(state).toEqual({ operation: 6, object: 7, innerClass: 0, nativeFailure: 0 }); expect(proof.unsafe).toBe(false);
});
it.each([
  ["CreateDirectoryW failed (Windows error 1314).", 1], ["CreateDirectoryW failed (Windows error 5).", 2],
  ["ConvertStringSecurityDescriptorToSecurityDescriptorW failed (Windows error 87).", 3],
  ["ConvertStringSecurityDescriptorToSecurityDescriptorW failed (Windows error 4294967295).", 3],
  ["CreateDirectoryW failed (Windows error 0).", 4], ["CreateDirectoryW failed (Windows error 183).", 4],
  ["CreateDirectoryW failed (Windows error 4294967295).", 4], ["CreateDirectoryW failed (Windows error 4294967296).", 0],
  ["ConvertStringSecurityDescriptorToSecurityDescriptorW failed (Windows error -1).", 0],
  ["CreateDirectoryW failed (Windows error 05).", 0], ["CreateDirectoryW failed (Windows error 5). PRIVATE", 0],
  ["PRIVATE path failed", 0], ["CreateDirectoryW failed (Windows error 5)\n.", 0],
] as const)("preparation native message shape maps only to closed enum %#", (message, kind) => {
  const error = new Error(message), state = { operation: 0, object: 0, innerClass: 0, nativeFailure: 0 }; let caught: unknown;
  expect(windowsNodeAssetPreparationNativeFailure(error)).toBe(kind);
  try { observeWindowsNodeAssetPreparation(diagnosticClasses, state, 5, 1, () => { throw error; }); } catch (value) { caught = value; }
  expect(caught).toBe(error); expect(state.nativeFailure).toBe(kind); expect(state.innerClass).toBe(0);
});
it("preparation diagnostic never invokes forged error getters or coerces message values", () => {
  const read = vi.fn(() => { throw Error("PRIVATE message getter"); }), value = { toString: read };
  const trap = vi.fn(() => { throw Error("PRIVATE prototype trap"); });
  const getter = Object.defineProperty(new Error(), "message", { get: read });
  const claimed = Object.defineProperties({}, { message: { value: "CreateDirectoryW failed (Windows error 1314)." }, name: { get: read } });
  const coercion = Object.defineProperty(new Error(), "message", { value });
  const proxy = new Proxy(new Error("CreateDirectoryW failed (Windows error 1314)."), { getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  expect(windowsNodeAssetPreparationNativeFailure(proxy)).toBe(0); expect(trap).not.toHaveBeenCalled();
  for (const original of [getter, claimed, coercion, proxy]) {
    const state = { operation: 0, object: 0, innerClass: 0, nativeFailure: 0 }; let caught: unknown;
    try { observeWindowsNodeAssetPreparation(diagnosticClasses, state, 5, 1, () => { throw original; }); } catch (error) { caught = error; }
    expect(caught).toBe(original); expect(state.nativeFailure).toBe(0);
  }
  expect(read).not.toHaveBeenCalled(); expect(trap).toHaveBeenCalledTimes(1); // Only the unchanged exact-loaded-class check reaches the guarded prototype trap.
});
it("preparation message classification authenticates native errors across realms before inspecting own message data", () => {
  const actual: unknown = runInNewContext('new Error("CreateDirectoryW failed (Windows error 1314).")');
  expect(windowsNodeAssetPreparationNativeFailure(actual)).toBe(1);
  const impostor: unknown = Object.defineProperty(Object.create(Error.prototype), "message", { value: "CreateDirectoryW failed (Windows error 1314)." });
  expect(windowsNodeAssetPreparationNativeFailure(impostor)).toBe(0);
});
it("failed preparation projection/storage cannot change the original return or exception", () => {
  const state = Object.freeze({ operation: 0, object: 0, innerClass: 0, nativeFailure: 0 }), expected = Object.freeze({});
  const classes = Object.defineProperty({ ...diagnosticClasses }, "WindowsRootOnlyCommandCopyCleanupError", { get: () => { throw Error("PRIVATE classifier failure"); } });
  const original = new Error("CreateDirectoryW failed (Windows error 1314)."); let caught: unknown;
  expect(observeWindowsNodeAssetPreparation(classes, state, 5, 1, () => expected)).toBe(expected);
  try { observeWindowsNodeAssetPreparation(classes, state, 5, 1, () => { throw original; }); } catch (error) { caught = error; }
  expect(caught).toBe(original); expect(state).toEqual({ operation: 0, object: 0, innerClass: 0, nativeFailure: 0 });
});
it("preparation metadata is bounded own data and has no admission or disposal authority", () => {
  const value = { operation: 13, object: 10, innerClass: 8, nativeFailure: 4 };
  const project = (state: typeof value) => new WindowsNodeAssetEnforcementObservationError("natural-default", 2, 0, 0, 6, 0, 0, 0, [], 0, 0, 0, 0, 0, 0, undefined, state);
  expect(project(value)).toMatchObject({ preparationOperation: 13, preparationObject: 10, preparationInnerClass: 8, preparationNativeFailure: 4 });
  expect(project({ operation: 14, object: 11, innerClass: 9, nativeFailure: 5 })).toMatchObject({ preparationOperation: 0, preparationObject: 0, preparationInnerClass: 0, preparationNativeFailure: 0 });
  const read = vi.fn(() => { throw Error("PRIVATE preparation field"); });
  expect(project(Object.defineProperty({ ...value }, "operation", { get: read }))).toMatchObject({ preparationOperation: 0 }); expect(read).not.toHaveBeenCalled();
});
it("preparation observations stay inside original guards and reset before the asset factory", () => {
  const source = fs.readFileSync(new URL("../fixtures/windows-node-asset-enforcement-proof.ts", import.meta.url), "utf8");
  expect(source).toContain("=> native(() => observeWindowsNodeAssetPreparation(loaded, preparationObservation, operation, object, fn));");
  const phase = source.slice(source.indexOf("phase = 2; api ="), source.indexOf("phase = 3; node ="));
  expect(phase.indexOf("preparation(1, 0")).toBeLessThan(phase.indexOf("preparation(2, 0"));
  expect(phase.indexOf("preparation(5, index + 1")).toBeLessThan(phase.indexOf("preparation(6, index + 1"));
  expect(phase.indexOf("preparation(13, 0")).toBeLessThan(phase.indexOf("preparationObservation = { operation: 0, object: 0, innerClass: 0, nativeFailure: 0 };"));
  expect(phase).not.toMatch(/GetLastError|AdjustTokenPrivileges|SetSecurity|await|\.catch\(/);
});
it("Node checkpoints follow an actual Copy context, output launch and held attester before its genuine run resolves", async () => {
  const s = outputFake(), copy = await s.prepare(), io = s.owner(), state = { checkpoint: 1, innerClass: 0 };
  let launch: Parameters<typeof requireWindowsNodeAssetHeldToken>[3] | undefined;
  const run = await copy.launchRootOnlyWithOutput(context => observeWindowsNodeAssetNodeCall(diagnosticClasses, state, 2, 3, () => {
    expect(state.checkpoint).toBe(2); launch = io.createSuspended(context, "C:\\trusted\\node.exe", s.command);
    expect(requireWindowsCommandOutputLaunch(launch).context).toBe(context); return launch;
  }), held => {
    expect(state.checkpoint).toBe(3);
    observeWindowsNodeAssetNodeCall(diagnosticClasses, state, 4, 5, () => {
      expect(state.checkpoint).toBe(4); expect(requireWindowsCommandOutputLaunch(launch!).root).toEqual(held);
    });
    observeWindowsNodeAssetNodeCall(diagnosticClasses, state, 5, 6, () => { expect(state.checkpoint).toBe(5); });
  });
  expect(state).toEqual({ checkpoint: 6, innerClass: 0 }); expect(s.events).toContain("resume");
  s.state.ended = true; const completed = await copy.completeRootOnly(run, io.signal); await io.closeOutputAfterStopped(completed, run);
  await copy.close(); closeWindowsCommandCreatorProfile(s.profile);
});
it("a genuine creator failure remains fatal class1 with its unknown positive launch retained and no Resume", async () => {
  const s = outputFake(), copy = await s.prepare(), io = s.owner(), state = { checkpoint: 1, innerClass: 0 }, original = new WindowsNodeToolchainCleanupError();
  const error = await copy.launchRootOnlyWithOutput(context => observeWindowsNodeAssetNodeCall(diagnosticClasses, state, 2, 3, () => {
    io.createSuspended(context, "C:\\trusted\\node.exe", s.command); throw original;
  }), () => undefined).catch(error => error);
  expect(error).toBeInstanceOf(WindowsRootOnlyCommandCopyCleanupError); expect(windowsNodeAssetErrorClass(diagnosticClasses, error)).toBe(1);
  expect(state).toEqual({ checkpoint: 2, innerClass: 8 }); expect(s.events).not.toContain("resume");
  expect([...s.handles.values()].some(handle => !handle.closed)).toBe(true); await expect(copy.close()).rejects.toBe(error);
});
it("Node checkpoint and inner class are bounded observations with no success or cleanup authority", () => {
  const known = new WindowsNodeAssetEnforcementObservationError("natural", 5, 14, 49, 1, 0, 0, 0, [], 1, 2, 2, 1, 7, 8);
  expect(known).toMatchObject({ phase: 5, cExit: 49, errorClass: 1, nodeCheckpoint: 7, nodeInnerClass: 8 });
  for (const value of [-1, 8, Infinity, NaN]) expect(new WindowsNodeAssetEnforcementObservationError("natural", 5, 14, 49, 1, 0, 0, 0, [], 0, 0, 0, 0, value).nodeCheckpoint).toBe(0);
  for (const value of [-1, 9, Infinity, NaN]) expect(new WindowsNodeAssetEnforcementObservationError("natural", 5, 14, 49, 1, 0, 0, 0, [], 0, 0, 0, 0, 1, value).nodeInnerClass).toBe(0);
});
it("checkpoint7 is assigned only after the existing Copy launch await and never controls admission or cleanup", () => {
  const source = fs.readFileSync(new URL("../fixtures/windows-node-asset-enforcement-proof.ts", import.meta.url), "utf8");
  const node = source.slice(source.indexOf("phase = 5; verified()"), source.indexOf("native(() => targetPins!.recheck()); verified(); phase = 7;"));
  expect(node.indexOf("nodeObservation.checkpoint = 1;")).toBeLessThan(node.indexOf("copy.launchRootOnlyWithOutput"));
  expect(node.indexOf("nodeObservation.checkpoint = 7;")).toBeGreaterThan(node.indexOf('if (mode === "preresume") assetCurrent = false; });'));
  expect(node.indexOf("nodeObservation.checkpoint = 7;")).toBeLessThan(node.indexOf('if (mode === "preresume" || mode === "sharedcreate") authenticateStop(1)'));
  expect(node.match(/nodeObservation\.checkpoint = 7/g)).toHaveLength(1); expect(source.match(/const nodeObservation = \{ checkpoint: 0, innerClass: 0 \}/g)).toHaveLength(1);
  expect(node).not.toMatch(/if\s*\([^\n]*(?:nodeObservation|nodeCheckpoint|nodeInnerClass)/);
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
it("passive launch observation preserves the original promise, genuine witness and callback return", async () => {
  const s = actualStopFixture(), state = windowsNodeAssetLaunchObservation(); let original: Promise<number> | undefined;
  const capture = vi.fn((witness: Parameters<NonNullable<Parameters<WindowsCommandRootOnlyStopOwner["launch"]>[3]>>[0]) => {
    requireWindowsCommandRootOnlyAttestingCurrent(witness, s.binding); expect(state.captureCheckpoint).toBe(1);
  });
  const tracked: WindowsCommandRootOnlyStopOwner = { ...s.real, launch(...args) { original = s.real.launch(...args); return original; } };
  const observed = observeWindowsNodeAssetStop(tracked, s.binding, requireWindowsCommandRootOnlyStopped, () => undefined, launchReaders, state);
  const pending = observed.launch(s.create, () => undefined, () => true, capture); expect(pending).toBe(original);
  expect(await pending).toBe(31); expect(capture).toHaveBeenCalledOnce(); expect(state).toEqual({ ...windowsNodeAssetLaunchObservation(), captureCheckpoint: 2 });
  expect(() => requireWindowsCommandRootOnlyAttestingCurrent(capture.mock.calls[0][0], s.binding)).toThrow();
  await observed.stop();
});
it.each([{ name: "object", value: Object.freeze({}) }, { name: "promise", value: Promise.resolve() }])("the real Stop guard still rejects a capture's invalid $name return", async ({ value }) => {
  const s = actualStopFixture(), state = windowsNodeAssetLaunchObservation(); let original: Promise<number> | undefined;
  const tracked: WindowsCommandRootOnlyStopOwner = { ...s.real, launch(...args) { original = s.real.launch(...args); return original; } };
  const observed = observeWindowsNodeAssetStop(tracked, s.binding, requireWindowsCommandRootOnlyStopped, () => undefined, launchReaders, state);
  const capture = vi.fn(() => value), pending = observed.launch(s.create, () => undefined, () => true, capture);
  expect(pending).toBe(original); const error = await pending.catch(error => error);
  expect(error).toBeInstanceOf(WindowsCommandRootOnlyCleanupError); expect(capture).toHaveBeenCalledOnce(); expect(s.events).not.toContain("resume");
  expect(state).toEqual({ captureCheckpoint: 2, captureInnerClass: 0, stopStage: 8, stopOperation: 0, stopPredicate: 8, stopConstraint: 0 });
  expect(s.fence.retained.length).toBeGreaterThan(0);
});
it("a supplied capture sees the same original exception before genuine Stop transforms its rejection", async () => {
  const s = actualStopFixture(), state = windowsNodeAssetLaunchObservation(), original = new WindowsNodeToolchainCleanupError();
  const observed = observeWindowsNodeAssetStop(s.real, s.binding, requireWindowsCommandRootOnlyStopped, () => undefined, launchReaders, state);
  let rethrown: unknown;
  const pending = observed.launch(s.create, () => undefined, () => true, () => {
    try { throw original; } catch (error) { rethrown = error; throw error; }
  });
  const error = await pending.catch(error => error); expect(rethrown).toBe(original); expect(error).toBeInstanceOf(WindowsCommandRootOnlyCleanupError);
  expect(state).toEqual({ captureCheckpoint: 1, captureInnerClass: 8, stopStage: 8, stopOperation: 0, stopPredicate: 1, stopConstraint: 0 });
  expect(s.events).not.toContain("resume");
});
it.each([null, {}, Promise.resolve()])("an invalid capture argument %# remains invalid before any creator call", async capture => {
  const s = actualStopFixture(), state = windowsNodeAssetLaunchObservation(), create = vi.fn(s.create);
  const observed = observeWindowsNodeAssetStop(s.real, s.binding, requireWindowsCommandRootOnlyStopped, () => undefined, launchReaders, state);
  const pending = observed.launch(create, () => undefined, () => true, capture as Parameters<WindowsCommandRootOnlyStopOwner["launch"]>[3]);
  await expect(pending).rejects.toBeInstanceOf(Error); expect(create).not.toHaveBeenCalled(); expect(state.captureCheckpoint).toBe(0);
  expect(s.events).not.toContain("resume"); await observed.stop();
});
it("no-capture launch preserves exact arguments and records no invented capture", async () => {
  const s = actualStopFixture(), state = windowsNodeAssetLaunchObservation(), attest = () => undefined, current = () => true;
  let actualArgs: unknown[] = [], original: Promise<number> | undefined;
  const tracked: WindowsCommandRootOnlyStopOwner = { ...s.real, launch(...args) { actualArgs = args; original = s.real.launch(...args); return original; } };
  const observed = observeWindowsNodeAssetStop(tracked, s.binding, requireWindowsCommandRootOnlyStopped, () => undefined, launchReaders, state);
  const pending = observed.launch(s.create, attest, current); expect(pending).toBe(original); expect(actualArgs).toEqual([s.create, attest, current]);
  expect(await pending).toBe(31); expect(state).toEqual(windowsNodeAssetLaunchObservation()); await observed.stop();
});
it.each([false, true])("observer attachment failure preserves original promise and settlement %#", async failure => {
  const s = actualStopFixture(), state = windowsNodeAssetLaunchObservation(), attachment = vi.fn(() => { throw Error("PRIVATE attachment failure"); });
  let original: Promise<number> | undefined;
  const tracked: WindowsCommandRootOnlyStopOwner = { ...s.real, launch(...args) {
    original = s.real.launch(...args); Object.defineProperty(original, "then", { get: attachment }); return original;
  } };
  const observed = observeWindowsNodeAssetStop(tracked, s.binding, requireWindowsCommandRootOnlyStopped, () => undefined, launchReaders, state);
  const pending = observed.launch(s.create, () => undefined, () => true, failure ? () => ({}) : undefined); expect(pending).toBe(original);
  let value: unknown, error: unknown; try { value = await pending; } catch (caught) { error = caught; }
  expect(attachment).toHaveBeenCalledOnce(); expect(state.stopStage).toBe(0);
  if (failure) { expect(error).toBeInstanceOf(WindowsCommandRootOnlyCleanupError); expect(s.events).not.toContain("resume"); }
  else { expect(value).toBe(31); expect(error).toBeUndefined(); await observed.stop(); }
});
it("observer storage and branded-reader faults cannot replace a real failed promise", async () => {
  const s = actualStopFixture(), state = Object.freeze(windowsNodeAssetLaunchObservation());
  const readers = Object.defineProperty({ ...launchReaders }, "windowsCommandRootOnlyFailure", { get: () => { throw Error("PRIVATE reader fault"); } });
  let original: Promise<number> | undefined;
  const tracked: WindowsCommandRootOnlyStopOwner = { ...s.real, launch(...args) { original = s.real.launch(...args); return original; } };
  const observed = observeWindowsNodeAssetStop(tracked, s.binding, requireWindowsCommandRootOnlyStopped, () => undefined, readers, state);
  const pending = observed.launch(s.create, () => undefined, () => true, () => { throw new WindowsCommandOutputCleanupError(); });
  expect(pending).toBe(original); await expect(pending).rejects.toBeInstanceOf(WindowsCommandRootOnlyCleanupError);
  expect(state).toEqual(windowsNodeAssetLaunchObservation()); expect(s.events).not.toContain("resume");
});
it("foreign error metadata getters are never consulted by the genuine Stop diagnostic accessor", async () => {
  const read = vi.fn(() => { throw Error("PRIVATE foreign metadata"); });
  const error = Object.defineProperties({}, Object.fromEntries(["stage", "operation", "predicate", "constraint", "domain", "code", "name", "message", "cause", "stack"].map(key => [key, { get: read }])));
  const original = Promise.reject<number>(error), state = windowsNodeAssetLaunchObservation();
  const owner = { scope: "root-only", launch: () => original } as unknown as WindowsCommandRootOnlyStopOwner;
  const observed = observeWindowsNodeAssetStop(owner, {}, requireWindowsCommandRootOnlyStopped, () => undefined, launchReaders, state);
  const pending = observed.launch(() => ({ process: 1n, thread: 2n, pid: 1 }), () => undefined, () => true); expect(pending).toBe(original);
  let caught: unknown; try { await pending; } catch (value) { caught = value; }
  expect(caught).toBe(error); expect(read).not.toHaveBeenCalled(); expect(state).toEqual(windowsNodeAssetLaunchObservation());
});
it("C capture and failure facts cannot bleed into a fresh Node generation without capture", async () => {
  const c = actualStopFixture(), first = windowsNodeAssetLaunchObservation(); let latest = first;
  const prior = observeWindowsNodeAssetStop(c.real, c.binding, requireWindowsCommandRootOnlyStopped, () => undefined, launchReaders, first);
  await prior.launch(c.create, () => undefined, () => true, () => undefined); await prior.stop(); expect(first.captureCheckpoint).toBe(2); expect(latest).toBe(first);
  latest = windowsNodeAssetLaunchObservation(); expect(latest).toEqual(windowsNodeAssetLaunchObservation());
  const n = actualStopFixture(), current = windowsNodeAssetLaunchObservation(); latest = current;
  const next = observeWindowsNodeAssetStop(n.real, n.binding, requireWindowsCommandRootOnlyStopped, () => undefined, launchReaders, current);
  await expect(next.launch(n.create, () => { throw Error("Fixed attester refusal."); }, () => true, () => undefined)).rejects.toBeInstanceOf(WindowsCommandRootOnlyCleanupError);
  expect(latest.captureCheckpoint).toBe(0); expect(latest.captureInnerClass).toBe(0); expect(latest.stopStage).toBe(8); expect(first.captureCheckpoint).toBe(2);
});
it("an observed capture failure remains outer Copy class1 with an unknown real launch retained", async () => {
  const s = outputFake(), observation = windowsNodeAssetLaunchObservation(), seen = vi.fn();
  const api = { createJob: () => 50000n, assign() { s.state.assigned = true; }, resume() { s.events.push("resume"); },
    terminateProcess() { s.state.ended = true; }, terminateJob() { s.state.ended = true; } } as unknown as WindowsLpacApi;
  const native = { configure() {}, assertLimits() {}, state: () => ({ total: s.state.assigned ? 1 : 0, active: s.state.assigned && !s.state.ended ? 1 : 0, pids: s.state.assigned && !s.state.ended ? [s.state.returnedPid] : [] }),
    processId: () => s.state.returnedPid, threadProcessId: () => s.state.returnedPid, member: () => s.state.assigned, wait: (): 0 | 258 => s.state.ended ? 0 : 258, close() {} };
  const copy = await WindowsRootOnlyCommandCopy.create({ ...s.source.input(), creatorProfile: s.profile, packageSid: windowsCommandCreatorProfile(s.profile).sidText,
    packageCurrent: () => true, reviewCurrent: () => true }, { api, fence: s.copyFence,
    async createTree(input) { const tree = await s.source.binding.createFreshWindowsCommandTree(input); return { ...tree, captureCreator(ref, witness) { tree.captureCreator!(ref, witness); throw new WindowsNodeToolchainCleanupError(); } }; },
    createStopOwner(binding) { const real = createWindowsCommandRootOnlyStopOwner(binding, api, native, () => 100, s.stopFence);
      return observeWindowsNodeAssetStop(real, binding, requireWindowsCommandRootOnlyStopped, seen, launchReaders, observation); } });
  const io = s.owner(), error = await copy.launchRootOnlyWithOutput(context => io.createSuspended(context, "C:\\trusted\\node.exe", s.command), () => undefined).catch(error => error);
  expect(error).toBeInstanceOf(WindowsRootOnlyCommandCopyCleanupError); expect(windowsNodeAssetErrorClass(diagnosticClasses, error)).toBe(1);
  expect(observation).toMatchObject({ captureCheckpoint: 1, captureInnerClass: 8, stopStage: 8, stopPredicate: 1 });
  expect(s.events).not.toContain("resume"); expect(seen).not.toHaveBeenCalled(); expect([...s.handles.values()].some(handle => !handle.closed)).toBe(true);
  await expect(copy.close()).rejects.toBe(error);
});
it("capture and branded Stop projections are bounded, detached and read no raw status or accessor", () => {
  const value = { captureCheckpoint: 2, captureInnerClass: 8, stopStage: 14, stopOperation: 7, stopPredicate: 11, stopConstraint: 21 };
  const project = (observation: typeof value) => new WindowsNodeAssetEnforcementObservationError("natural", 5, 14, 49, 1, 0, 0, 0, [], 1, 2, 2, 1, 6, 0, observation);
  const known = project(value); value.stopStage = 0; expect(known).toMatchObject({ captureCheckpoint: 2, captureInnerClass: 8, stopStage: 14, stopOperation: 7, stopPredicate: 11, stopConstraint: 21 });
  for (const [key, bad] of [["captureCheckpoint", 3], ["captureInnerClass", 9], ["stopStage", 15], ["stopOperation", 8], ["stopPredicate", 12], ["stopConstraint", 22]] as const)
    expect(project({ ...value, [key]: bad })[key]).toBe(0);
  const read = vi.fn(() => { throw Error("PRIVATE status"); });
  const claimed = Object.defineProperties({ ...value }, { stopStage: { get: read }, domain: { get: read }, code: { get: read } });
  expect(project(claimed).stopStage).toBe(0); expect(read).not.toHaveBeenCalled();
});
it("the fixed observer resets before Node verification and gives each Stop owner an isolated record", () => {
  const source = fs.readFileSync(new URL("../fixtures/windows-node-asset-enforcement-proof.ts", import.meta.url), "utf8");
  expect(source).toContain("createStopOwner(binding) { const observation = windowsNodeAssetLaunchObservation(); launchObservation = observation;");
  expect(source).toContain("launchObservation = windowsNodeAssetLaunchObservation();\n      phase = 5; verified();");
  expect(source).toContain("loaded!, observation);");
});
it("first source/loader failure permanently closes the private observer before another loader/native entry", async () => {
  const load = vi.fn(() => { throw Error("PRIVATE source location"); }), observe = bindWindowsNodeAssetEnforcement({ load });
  const input = { executable: "relative", module: "relative", program: "relative" };
  const first = await observe(input, () => undefined, "relative", "relative", "natural").catch(error => error);
  expect(first).toBeInstanceOf(WindowsNodeAssetEnforcementObservationError); expect(first).toMatchObject({ phase: 1, preludeStage: 0, cExit: 0, errorClass: 0 });
  expect(String(first)).not.toContain("PRIVATE"); expect(load).not.toHaveBeenCalled();
  expect(await observe(input, () => undefined, "relative", "relative", "cancel").catch(error => error)).toBe(first);
});
it("the default-Medium fixture uses a non-inheriting Medium ancestor label and genuinely unlabeled borrowed parent without weakening its DACL", () => {
  const owner = "S-1-5-21-1-2-3-1000", packageSid = "S-1-15-2-123-456-789-10-11-12-13";
  const explicit = windowsNodeAssetCreationSecurity(owner, packageSid, "natural"), implicit = windowsNodeAssetCreationSecurity(owner, packageSid, "natural-default");
  expect(explicit.privateParent).toContain("S:(ML;OICI;NW;;;ME)"); expect(implicit.privateParent).not.toContain("S:");
  expect(implicit.directory).toMatch(/S:\(ML;;NW;;;ME\)$/); expect(implicit.directory).not.toContain("S:P");
  expect(explicit.directory).toMatch(/S:\(ML;OICI;NW;;;ME\)$/);
  const dacl = (value: string) => value.slice(value.indexOf("D:"), value.includes("S:") ? value.indexOf("S:") : value.length);
  const ownerGroupDacl = (value: string) => value.slice(0, value.includes("S:") ? value.indexOf("S:") : value.length);
  for (const key of ["directory", "tools", "treeParent", "privateParent", "lowOwner", "lowFullDirectory", "lowFullFile", "lowReadDirectory", "lowReadFile", "program"] as const)
    expect(ownerGroupDacl(implicit[key])).toBe(ownerGroupDacl(explicit[key]));
  expect(dacl(implicit.privateParent)).toBe(dacl(implicit.lowOwner)); expect(dacl(explicit.privateParent)).toBe(dacl(implicit.privateParent));
  expect(implicit.lowOwner).toContain("S:(ML;OICI;NW;;;LW)"); expect(implicit.privateParent).not.toContain(packageSid);
  expect(implicit.lowFullDirectory).toContain(`(A;OICI;FA;;;${packageSid})`); expect(implicit.lowFullFile).toContain(`(A;;FA;;;${packageSid})`);
  expect(implicit.lowFullDirectory.replace(`(A;OICI;FA;;;${packageSid})`, `(A;OICI;0x1200a9;;;${packageSid})`)).toBe(implicit.lowReadDirectory);
  expect(implicit.lowFullFile.replace(`(A;;FA;;;${packageSid})`, `(A;;0x1200a9;;;${packageSid})`)).toBe(implicit.lowReadFile);
  for (const descriptor of [implicit.lowFullDirectory, implicit.lowReadDirectory]) expect(descriptor).toContain("(A;OICI;RC;;;OW)");
  for (const descriptor of [implicit.lowFullFile, implicit.lowReadFile]) expect(descriptor).toContain("(A;;RC;;;OW)");
  expect(implicit.lowReadDirectory).toContain("S:(ML;OICI;NW;;;LW)"); expect(implicit.lowReadFile).toContain("S:(ML;;NW;;;LW)");
  const source = fs.readFileSync(new URL("../fixtures/windows-node-asset-enforcement-proof.ts", import.meta.url), "utf8");
  expect(source).toContain('parentLabel: mode === "natural-default" ? "default" : "explicit"');
  expect(source).not.toMatch(/AdjustTokenPrivileges|SetSecurityInfo|SetNamedSecurityInfo/);
  expect(() => windowsNodeAssetCreationSecurity("S-1-5-18", packageSid, "natural-default")).toThrow();
});
