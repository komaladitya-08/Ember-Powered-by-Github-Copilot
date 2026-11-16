import { expect, it, vi } from "vitest";
import { outputFake } from "../fixtures/windows-command-output-fake";
import { requireWindowsCommandRootOnlyCompleted } from "../../app/main/agent/windows-command-copy";
import { requireWindowsCommandOutputClosed } from "../../app/main/agent/windows-command-output";
import { closeWindowsCommandCreatorProfile } from "../../app/main/agent/windows-command-creator-profile";
import { createWindowsCommandRootOnlyStopOwner, requireWindowsCommandRootOnlyStopped, type WindowsCommandRootOnlyStopOwner } from "../../app/main/agent/windows-command-stop";
import { bindWindowsNodeAssetEnforcement, observeWindowsNodeAssetStop, requireWindowsNodeAssetOutputFacts,
  windowsNodeAssetCreationSecurity, NODE_ASSET_READY, NODE_ASSET_ERROR_READY, WindowsNodeAssetEnforcementObservationError } from "../fixtures/windows-node-asset-enforcement-proof";
import type { WindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";

const loaded = { requireWindowsCommandRootOnlyCompleted, requireWindowsCommandOutputClosed };
const until = async (check: () => boolean) => { const deadline = performance.now() + 4000; while (!check()) { if (performance.now() > deadline) throw Error("Fixed portable asset deadline."); await new Promise<void>(resolve => setTimeout(resolve, 5)); } };
const chunks = (s: ReturnType<typeof outputFake>, stream: number, bytes: Buffer) => { for (let at = 0; at < bytes.length; at += 16384) s.enqueue(stream, bytes.subarray(at, at + 16384)); };
async function natural(prelude = false) {
  const s = outputFake(), v = await s.launch(); s.state.code = prelude ? 19 : 17;
  const stdout = prelude ? Buffer.from("EMBER_ASSET_ACCESS_V1:255:511:1\n") : Buffer.concat([Buffer.from(NODE_ASSET_READY), Buffer.alloc(73728, 79), Buffer.from("\nEMBER_NODE_ASSET_DONE\n")]);
  const stderr = prelude ? Buffer.from("EMBER_ASSET_ACCESS_STDERR\n") : Buffer.concat([Buffer.from(NODE_ASSET_ERROR_READY), Buffer.alloc(67584, 69), Buffer.from("\nEMBER_NODE_ASSET_STDERR_DONE\n")]);
  chunks(s, 0, stdout); chunks(s, 1, stderr); s.state.ended = true;
  const completed = await v.copy.completeRootOnly(v.run, v.io.signal), closed = await v.io.closeOutputAfterStopped(completed, v.run);
  await v.copy.close(); closeWindowsCommandCreatorProfile(s.profile);
  return { s, input: { mode: prelude ? "prelude" as const : "natural" as const, completed, closed, run: v.run, launch: v.ref, stdout, stderr } };
}
it.each([false, true])("fixed genuine natural/C access output requires real closed exact-run references %#", async prelude => {
  const { s, input } = await natural(prelude);
  expect(requireWindowsNodeAssetOutputFacts(loaded, input)).toMatchObject({ exitCode: prelude ? 19 : 17, reason: "none", complete: true });
  expect([...s.handles.values()].every(handle => handle.closed)).toBe(true); expect([...s.allocations.values()].every(allocation => allocation.freed)).toBe(true);
});
it.each(["completed", "closed", "run", "launch"] as const)("a structural %s copy cannot certify native asset output", async field => {
  const { input } = await natural(); expect(() => requireWindowsNodeAssetOutputFacts(loaded, { ...input, [field]: { ...input[field] } })).toThrow();
});
it("a genuine closure cannot make altered output, denial counters or another mode pass", async () => {
  const { input } = await natural(true), changed = Buffer.from(input.stdout); changed[24] ^= 1;
  expect(() => requireWindowsNodeAssetOutputFacts(loaded, { ...input, stdout: changed })).toThrow();
  expect(() => requireWindowsNodeAssetOutputFacts(loaded, { ...input, mode: "natural" })).toThrow();
  expect(() => requireWindowsNodeAssetOutputFacts(loaded, { ...input, stderr: Buffer.concat([input.stderr, Buffer.from("x")]) })).toThrow();
});
it.each(["cancel", "overflow"] as const)("fixed %s bytes require genuine automatic Stop and incomplete closed output", async mode => {
  const s = outputFake(), v = await s.launch(); chunks(s, 0, Buffer.from(NODE_ASSET_READY)); chunks(s, 1, Buffer.from(NODE_ASSET_ERROR_READY));
  await until(() => s.output.length >= 2);
  if (mode === "cancel") s.abort.abort(); else for (let index = 0; index < 32; index++) chunks(s, 0, Buffer.alloc(16384, 88));
  await until(() => s.events.includes("stop-root") && s.events.includes("stop-job"));
  const completed = await v.copy.completeRootOnly(v.run, v.io.signal), closed = await v.io.closeOutputAfterStopped(completed, v.run);
  const stdout = Buffer.concat(s.output.filter(item => item.stream === "stdout").map(item => item.bytes)), stderr = Buffer.concat(s.output.filter(item => item.stream === "stderr").map(item => item.bytes));
  const input = { mode, completed, closed, run: v.run, launch: v.ref, stdout, stderr };
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
  expect(first).toBeInstanceOf(WindowsNodeAssetEnforcementObservationError); expect(String(first)).not.toContain("PRIVATE"); expect(load).not.toHaveBeenCalled();
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
  expect(() => windowsNodeAssetCreationSecurity("S-1-5-18", packageSid, "natural-default")).toThrow();
});
