import { expect, it, vi } from "vitest";
import { outputFake } from "../fixtures/windows-command-output-fake";
import { requireWindowsCommandRootOnlyCompleted } from "../../app/main/agent/windows-command-copy";
import { requireWindowsCommandOutputClosed } from "../../app/main/agent/windows-command-output";
import { closeWindowsCommandCreatorProfile } from "../../app/main/agent/windows-command-creator-profile";
import { createWindowsCommandRootOnlyStopOwner, requireWindowsCommandRootOnlyStopped, type WindowsCommandRootOnlyStopOwner } from "../../app/main/agent/windows-command-stop";
import { bindWindowsCommandOutputProof, observeWindowsCommandOutputStop, requireWindowsCommandOutputProofFacts,
  WINDOWS_COMMAND_OUTPUT_READY, WINDOWS_COMMAND_ERROR_READY, WindowsCommandOutputObservationError } from "../fixtures/windows-command-output-proof";
import type { WindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";

const loaded = { requireWindowsCommandRootOnlyCompleted, requireWindowsCommandOutputClosed };
const until = async (check: () => boolean) => { const deadline = performance.now() + 4_000; while (!check()) { if (performance.now() > deadline) throw Error("Fixed portable output deadline."); await new Promise<void>(resolve => setTimeout(resolve, 5)); } };
const chunks = (s: ReturnType<typeof outputFake>, stream: number, bytes: Buffer) => { for (let offset = 0; offset < bytes.length; offset += 16384) s.enqueue(stream, bytes.subarray(offset, offset + 16384)); };
async function natural() {
  const s = outputFake(), v = await s.launch(); s.state.code = 17;
  const stdout = Buffer.concat([Buffer.from(WINDOWS_COMMAND_OUTPUT_READY), Buffer.alloc(17 * 1024, "O"), Buffer.from("\nEMBER_OUTPUT_DONE\n")]);
  const stderr = Buffer.concat([Buffer.from(WINDOWS_COMMAND_ERROR_READY), Buffer.alloc(13 * 1024, "E"), Buffer.from("\nEMBER_ERROR_DONE\n")]);
  chunks(s, 0, stdout); chunks(s, 1, stderr); s.state.ended = true;
  const completed = await v.copy.completeRootOnly(v.run, v.io.signal), closed = await v.io.closeOutputAfterStopped(completed, v.run);
  await v.copy.close(); closeWindowsCommandCreatorProfile(s.profile);
  return { s, input: { mode: "natural" as const, completed, closed, run: v.run, launch: v.ref, stdout, stderr } };
}
it("accepts only the genuine completed nonzero-exit output frame, after EOF and all positive closes", async () => {
  const { s, input } = await natural();
  expect(requireWindowsCommandOutputProofFacts(loaded, input)).toMatchObject({ mode: "natural", exitCode: 17, reason: "none", complete: true, rootOnlyStop: 1 });
  expect([...s.handles.values()].every(value => value.closed)).toBe(true); expect([...s.allocations.values()].every(value => value.freed)).toBe(true);
});
it.each(["completed", "closed", "run", "launch"] as const)("a structurally copied %s cannot supply fixed native output facts", async field => {
  const { input } = await natural(); const foreign = { ...input, [field]: { ...input[field] } };
  expect(() => requireWindowsCommandOutputProofFacts(loaded, foreign)).toThrow();
});
it("a genuine closure cannot make altered fixed output or counters pass", async () => {
  const { input } = await natural(), altered = Buffer.from(input.stdout); altered[100] ^= 1;
  expect(() => requireWindowsCommandOutputProofFacts(loaded, { ...input, stdout: altered })).toThrow();
  expect(() => requireWindowsCommandOutputProofFacts(loaded, { ...input, stderr: Buffer.concat([input.stderr, Buffer.from("x")]) })).toThrow();
  expect(() => requireWindowsCommandOutputProofFacts(loaded, { ...input, mode: "cancel" })).toThrow();
});
it.each(["cancel", "overflow"] as const)("the fixed %s frame requires genuine cancellation and incomplete output facts", async mode => {
  const s = outputFake(), v = await s.launch(); chunks(s, 0, Buffer.from(WINDOWS_COMMAND_OUTPUT_READY)); chunks(s, 1, Buffer.from(WINDOWS_COMMAND_ERROR_READY));
  await until(() => s.output.length >= 2);
  if (mode === "cancel") s.abort.abort(); else for (let index = 0; index < 32; index++) chunks(s, 0, Buffer.alloc(16384, "X"));
  await until(() => s.events.includes("stop-root") && s.events.includes("stop-job"));
  const completed = await v.copy.completeRootOnly(v.run, v.io.signal), closed = await v.io.closeOutputAfterStopped(completed, v.run);
  const stdout = Buffer.concat(s.output.filter(value => value.stream === "stdout").map(value => value.bytes)), stderr = Buffer.concat(s.output.filter(value => value.stream === "stderr").map(value => value.bytes));
  const input = { mode, completed, closed, run: v.run, launch: v.ref, stdout, stderr };
  expect(requireWindowsCommandOutputProofFacts(loaded, input)).toMatchObject({ mode, exitCode: null, complete: false, reason: mode === "cancel" ? "cancelled" : "overflow" });
  const altered = Buffer.from(stdout); altered[altered.length - 1] ^= 1;
  expect(() => requireWindowsCommandOutputProofFacts(loaded, { ...input, stdout: altered })).toThrow();
  await v.copy.close(); closeWindowsCommandCreatorProfile(s.profile);
});
function emptyOwner() {
  const binding = Object.freeze({}), closes: bigint[] = [];
  const api = { createJob: () => 500n, terminateJob() {}, terminateProcess() {} } as unknown as WindowsLpacApi;
  const owner = createWindowsCommandRootOnlyStopOwner(binding, api, { configure() {}, assertLimits() {}, state: () => ({ total: 0, active: 0, pids: [] }),
    processId: () => 0, threadProcessId: () => 0, member: () => false, wait: () => 0, close(value) { closes.push(value); } }, () => 0, { retained: [] });
  return { binding, closes, owner };
}
it("observes the actual Stop promise and receipt only after native positive closure", async () => {
  const s = emptyOwner(), seen = vi.fn(), wrapped = observeWindowsCommandOutputStop(s.owner, s.binding, requireWindowsCommandRootOnlyStopped, ref => { expect(s.closes).toEqual([500n]); seen(ref); });
  const pending = wrapped.stop(); expect(pending).toBe(s.owner.stop()); const ref = await pending; await Promise.resolve();
  expect(seen).toHaveBeenCalledExactlyOnceWith(ref); expect(() => requireWindowsCommandRootOnlyStopped(ref, s.binding)).not.toThrow();
});
it.each(["foreign-binding", "callback-shaped"] as const)("%s cannot replace genuine Stop authentication", async fault => {
  const s = emptyOwner(), seen = vi.fn();
  const owner = fault === "callback-shaped" ? { ...s.owner, stop: () => Promise.resolve({ scope: "root-only" }) } as WindowsCommandRootOnlyStopOwner : s.owner;
  const wrapped = observeWindowsCommandOutputStop(owner, fault === "foreign-binding" ? {} : s.binding, requireWindowsCommandRootOnlyStopped, seen);
  await wrapped.stop(); await Promise.resolve(); await Promise.resolve(); expect(seen).not.toHaveBeenCalled();
});
it("changed source verification permanently blocks acquisition and no later call retries", async () => {
  const load = vi.fn(), api = vi.fn(), files = { lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }), realpathSync: { native: (file: string) => file } };
  const observe = bindWindowsCommandOutputProof({ load, api, files: files as never, managedTemporary: () => "C:\\managed" });
  const first = await observe({ executable: "C:\\build\\proof.exe", module: "C:\\build\\proof.cjs" }, () => { throw Error("PRIVATE changed input"); }, "C:\\scratch", "natural").catch(error => error);
  expect(first).toBeInstanceOf(WindowsCommandOutputObservationError); expect(String(first)).not.toContain("PRIVATE"); expect(load).not.toHaveBeenCalled(); expect(api).not.toHaveBeenCalled();
  await expect(observe({ executable: "C:\\build\\proof.exe", module: "C:\\build\\proof.cjs" }, () => undefined, "C:\\scratch", "natural")).rejects.toBe(first);
});
it.each(["relative", "C:/scratch", "C:\\scratch\\bad\"name", "C:\\scratch\\bad?name", "C:\\scratch\\bad\ud800name", "C:\\"])("invalid scratch identity %# refuses before source load or native acquisition", async scratch => {
  const load = vi.fn(), api = vi.fn(), observe = bindWindowsCommandOutputProof({ load, api });
  const error = await observe({ executable: "C:\\build\\proof.exe", module: "C:\\build\\proof.cjs" }, () => undefined, scratch, "natural").catch(value => value);
  expect(error).toBeInstanceOf(WindowsCommandOutputObservationError); expect(load).not.toHaveBeenCalled(); expect(api).not.toHaveBeenCalled();
});
it("a structurally substituted bundle cannot acquire a profile, process or Stop owner", async () => {
  const load = vi.fn(() => ({ createWindowsCommandOutput: () => undefined })), api = vi.fn();
  const files = { lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }), realpathSync: { native: (file: string) => file } };
  const observe = bindWindowsCommandOutputProof({ load: load as never, api, files: files as never, managedTemporary: () => "C:\\managed" });
  const error = await observe({ executable: "C:\\build\\proof.exe", module: "C:\\build\\proof.cjs" }, () => undefined, "C:\\scratch", "natural").catch(value => value);
  expect(error).toBeInstanceOf(WindowsCommandOutputObservationError); expect(load).toHaveBeenCalledExactlyOnceWith("C:\\build\\proof.cjs"); expect(api).not.toHaveBeenCalled();
});
