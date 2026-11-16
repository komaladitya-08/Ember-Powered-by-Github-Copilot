import { expect, it } from "vitest";
import type { WindowsLpacApi, WindowsSuspendedProcess } from "../../app/main/agent/experimental-windows-lpac-api";
import type { FreshWindowsCommandTree } from "../../app/main/agent/windows-command-copy-native";
import { ScopedCodingFileError } from "../../app/main/agent/coding-platform";
import { WindowsRootOnlyCommandCopy, WindowsRootOnlyCommandCopyCleanupError, type WindowsRootOnlyCommandCopyDependencies,
  type WindowsRootOnlyCommandCopyInput } from "../../app/main/agent/windows-command-copy";
import { createWindowsCommandRootOnlyStopOwner, type WindowsCommandRootOnlyStopNative,
  type WindowsCommandRootOnlyStopFence, type WindowsCommandRootOnlyStoppedRef } from "../../app/main/agent/windows-command-stop";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function setup() {
  const events: string[] = [], snapshots: Buffer[] = [];
  const state = { current: true, package: true, review: true, private: true, fault: "", grantGate: undefined as ReturnType<typeof deferred> | undefined,
    afterSnapshot: undefined as (() => void) | undefined, onCurrent: undefined as (() => void) | undefined, onReview: undefined as (() => void) | undefined };
  let next = 10n;
  const jobs = new Map<bigint, { total: number; process?: bigint }>(), processes = new Map<bigint, { pid: number; thread: bigint; exited: boolean }>();
  const stopFence: WindowsCommandRootOnlyStopFence = { retained: [] }, fence = { retained: [] as unknown[] };
  const api = {
    createJob() { const job = next++; jobs.set(job, { total: 0 }); events.push("job-create"); return job; },
    assign(job: bigint, process: bigint) { const record = jobs.get(job)!; record.process = process; record.total = 1; events.push("assign"); },
    resume() { events.push("resume"); },
    terminateProcess(process: bigint) { processes.get(process)!.exited = true; events.push("terminate-root"); },
    terminateJob(job: bigint) { const process = jobs.get(job)!.process; if (process) processes.get(process)!.exited = true; events.push("terminate-job"); },
    close(handle: bigint) { events.push(jobs.has(handle) ? "job-close" : "handle-close"); },
  } as unknown as WindowsLpacApi;
  const native: WindowsCommandRootOnlyStopNative = {
    configure() { events.push("limit-root-only"); }, assertLimits() {},
    state(job) { const record = jobs.get(job)!; const root = record.process ? processes.get(record.process)! : undefined;
      return { total: record.total, active: root && !root.exited ? 1 : 0, pids: root && !root.exited ? [root.pid] : [] }; },
    processId(process) { return processes.get(process)!.pid; }, threadProcessId(thread) { return [...processes.values()].find(root => root.thread === thread)!.pid; },
    member(process, job) { return jobs.get(job)!.process === process; },
    wait(handle) { const root = processes.get(handle) ?? [...processes.values()].find(root => root.thread === handle); return root?.exited ? 0 : 258; },
    close(handle) { api.close(handle); },
  };
  const tree: FreshWindowsCommandTree = {
    directory: "C:\\scratch\\fresh",
    async assertPrivate() { events.push("assert-private"); if (!state.private) throw new ScopedCodingFileError("boundary"); },
    async grant(sid, check) {
      events.push("grant-" + sid); state.private = false;
      if (state.grantGate) await state.grantGate.promise;
      check?.(); if (state.fault === "grant") throw Error("private raw native text");
    },
    async revoke(sid) { events.push("revoke-" + sid); if (state.fault === "revoke") throw Error("private raw native text"); state.private = true; },
    async snapshot(check) {
      events.push("snapshot"); check?.(); if (!state.private) throw Error("writer overlaps snapshot");
      if (state.fault === "snapshot") throw Error("private raw native text");
      const bytes = Buffer.from("private captured text"); snapshots.push(bytes);
      if (state.afterSnapshot) queueMicrotask(state.afterSnapshot);
      return [{ path: "fixed.txt", kind: "file", bytes, executable: false }];
    },
    async close() { events.push("tree-close"); if (state.fault === "close") throw Error("private raw native text"); },
  };
  const input: WindowsRootOnlyCommandCopyInput = { parent: "C:\\scratch", protectedPaths: ["C:\\protected"], entries: [], packageSid: "S-1-15-2-123-456",
    current: () => { state.onCurrent?.(); return state.current; }, packageCurrent: () => state.package,
    reviewCurrent: () => { state.onReview?.(); return state.review; } };
  const dependencies: WindowsRootOnlyCommandCopyDependencies = { api, fence, createTree: async () => tree,
    createStopOwner: binding => createWindowsCommandRootOnlyStopOwner(binding, api, native, () => 100, stopFence) };
  const create = (): WindowsSuspendedProcess => { const process = next++, thread = next++, pid = Number(next++); processes.set(process, { pid, thread, exited: false }); events.push("root-create"); return { process, thread, pid }; };
  const attest = () => { events.push("attest"); };
  const prepare = () => WindowsRootOnlyCommandCopy.create(input, dependencies);
  return { events, snapshots, state, input, dependencies, tree, create, attest, prepare, fence, stopFence };
}
it("creates root-only limits before grant, attests before Resume, and closes the exact job before revoking and reading", async () => {
  const s = setup(), owner = await s.prepare(); expect(owner.scope).toBe("root-only");
  await owner.launchRootOnly(s.create, s.attest);
  expect(s.events.indexOf("limit-root-only")).toBeLessThan(s.events.findIndex(event => event.startsWith("grant-")));
  expect(s.events.indexOf("attest")).toBeLessThan(s.events.indexOf("resume"));
  expect(await owner.files(async entries => entries[0].path)).toBe("fixed.txt");
  expect(s.events.indexOf("job-close")).toBeLessThan(s.events.findIndex(event => event.startsWith("revoke-")));
  expect(s.events.findIndex(event => event.startsWith("revoke-"))).toBeLessThan(s.events.indexOf("snapshot"));
  expect(s.snapshots[0].every(value => value === 0)).toBe(true); await owner.close();
});
it("serializes file work and launches with a new stopped-proof binding per generation", async () => {
  const s = setup(), owner = await s.prepare(), entered = deferred(), release = deferred();
  const reading = owner.files(async () => { entered.resolve(); await release.promise; }); await entered.promise;
  const running = owner.launchRootOnly(s.create, s.attest); expect(s.events).not.toContain("job-create");
  release.resolve(); await reading; await running; await owner.files(async () => undefined);
  await owner.launchRootOnly(s.create, s.attest); await owner.stop();
  expect(s.events.filter(event => event === "job-close")).toHaveLength(2); await owner.close();
});
it("Stop revokes starts immediately and permits only separately authorized stopped review", async () => {
  const s = setup(), owner = await s.prepare(); await owner.launchRootOnly(s.create, s.attest);
  const stopped = owner.stop();
  await expect(owner.launchRootOnly(s.create, s.attest)).rejects.toThrow("ended");
  await expect(owner.files(async () => undefined)).rejects.toThrow("ended"); await stopped;
  s.state.current = false; s.state.package = false;
  expect(await owner.review(async entries => entries.length)).toBe(1);
  expect(s.snapshots[0].every(value => value === 0)).toBe(true); await owner.close();
});
it("a cancelled partial grant obtains only an empty-job proof before revocation, with no creator or Resume", async () => {
  const s = setup(), owner = await s.prepare(); s.state.grantGate = deferred();
  const running = owner.launchRootOnly(s.create, s.attest); const observed = running.catch(error => error);
  while (!s.events.some(event => event.startsWith("grant-"))) await new Promise(resolve => setImmediate(resolve));
  const stopped = owner.stop(); s.state.grantGate.resolve();
  expect(await observed).toBeInstanceOf(ScopedCodingFileError); await stopped;
  expect(s.events).not.toContain("root-create"); expect(s.events).not.toContain("resume");
  expect(s.events).toContain("job-close"); expect(s.events.some(event => event.startsWith("revoke-"))).toBe(true); await owner.close();
});
it.each(["current", "package"] as const)("refuses a retired %s binding before native grant or creation", async kind => {
  const s = setup(), owner = await s.prepare(); s.state[kind] = false;
  await expect(owner.launchRootOnly(s.create, s.attest)).rejects.toBeInstanceOf(ScopedCodingFileError);
  expect(s.events).not.toContain("job-create"); expect(s.events).not.toContain("root-create"); await owner.close();
});
it("captured callbacks and package identity cannot be upgraded by mutating input", async () => {
  const s = setup(), owner = await s.prepare(); s.input.packageSid = "S-1-15-2-999"; s.input.current = () => true;
  s.state.current = false; await expect(owner.launchRootOnly(s.create, s.attest)).rejects.toBeInstanceOf(ScopedCodingFileError);
  s.state.current = true; await owner.launchRootOnly(s.create, s.attest); await owner.stop();
  expect(s.events.filter(event => event.startsWith("grant-") || event.startsWith("revoke-"))).toEqual(["grant-S-1-15-2-123-456", "revoke-S-1-15-2-123-456"]); await owner.close();
});
it("forged stopped metadata cannot authorize native grant revocation or a read", async () => {
  const s = setup(); s.dependencies.createStopOwner = () => ({ scope: "root-only", launch: async () => 1, retainStop() {},
    stop: async () => ({ scope: "root-only" }) as WindowsCommandRootOnlyStoppedRef });
  const owner = await s.prepare(); await owner.launchRootOnly(s.create, s.attest);
  await expect(owner.files(async () => true)).rejects.toBeInstanceOf(WindowsRootOnlyCommandCopyCleanupError);
  expect(s.events.some(event => event.startsWith("revoke-"))).toBe(false); expect(s.events).not.toContain("snapshot"); expect(s.events).not.toContain("tree-close");
  expect(s.fence.retained).toContain(owner);
});
it.each(["grant", "revoke", "snapshot", "close"])("fences and retains native %s uncertainty without publishing raw errors", async fault => {
  const s = setup(), owner = await s.prepare(); s.state.fault = fault;
  let operation: Promise<unknown>;
  if (fault === "grant") operation = owner.launchRootOnly(s.create, s.attest);
  else if (fault === "revoke") { await owner.launchRootOnly(s.create, s.attest); operation = owner.stop(); }
  else if (fault === "snapshot") operation = owner.files(async () => undefined);
  else operation = owner.close();
  const error = await operation.catch(error => error); expect(error).toBeInstanceOf(WindowsRootOnlyCommandCopyCleanupError);
  if (!(error instanceof WindowsRootOnlyCommandCopyCleanupError)) throw new Error("Expected the cleanup boundary error.");
  expect(error.message).not.toContain("raw");
  expect(s.fence.retained).toContain(owner); await expect(s.prepare()).rejects.toBeInstanceOf(WindowsRootOnlyCommandCopyCleanupError);
  const count = s.events.length; await expect(owner.files(async () => true)).rejects.toBeInstanceOf(WindowsRootOnlyCommandCopyCleanupError); expect(s.events.length).toBe(count);
});
it("rejects review before Stop or after publication revocation and wipes callback-error snapshots", async () => {
  const s = setup(), owner = await s.prepare();
  await expect(owner.review(async () => true)).rejects.toBeInstanceOf(ScopedCodingFileError);
  await expect(owner.files(async () => { throw Error("C:\\private\\path"); })).rejects.toThrow("could not be completed");
  expect(s.snapshots[0].every(value => value === 0)).toBe(true); await owner.stop(); s.state.review = false;
  const before = s.events.length; await expect(owner.review(async () => true)).rejects.toBeInstanceOf(ScopedCodingFileError); expect(s.events.length).toBe(before); await owner.close();
});
it("refuses nested file and Stop waits without deadlocking or admitting later work", async () => {
  const s = setup(), owner = await s.prepare();
  await expect(owner.files(async () => { await expect(owner.files(async () => true)).rejects.toBeInstanceOf(ScopedCodingFileError); await expect(owner.stop()).rejects.toBeInstanceOf(ScopedCodingFileError); })).rejects.toBeInstanceOf(ScopedCodingFileError);
  await owner.close();
});
it("shared copy uncertainty retains peer owners and requests only non-disposing Stop of their known root", async () => {
  const a = setup(), b = setup(); b.dependencies.fence = a.fence;
  const first = await a.prepare(), peer = await b.prepare();
  await peer.launchRootOnly(b.create, b.attest); a.state.fault = "snapshot";
  await expect(first.files(async () => undefined)).rejects.toBeInstanceOf(WindowsRootOnlyCommandCopyCleanupError);
  expect(a.fence.retained).toContain(first); expect(a.fence.retained).toContain(peer);
  expect(b.events).toContain("terminate-root"); expect(b.events).toContain("terminate-job");
  expect(b.events).not.toContain("job-close"); expect(b.events.some(event => event.startsWith("revoke-"))).toBe(false);
  await expect(peer.close()).rejects.toBeInstanceOf(WindowsRootOnlyCommandCopyCleanupError); expect(b.events).not.toContain("tree-close");
});
it.each(["work", "review"] as const)("rechecks %s authority after snapshot await before exposing its bytes", async mode => {
  const s = setup(), owner = await s.prepare(); if (mode === "review") await owner.stop();
  s.state.afterSnapshot = () => { if (mode === "work") s.state.current = false; else s.state.review = false; };
  let invoked = false;
  const callback = async () => { invoked = true; return "forbidden"; };
  await expect(mode === "work" ? owner.files(callback) : owner.review(callback)).rejects.toBeInstanceOf(ScopedCodingFileError);
  expect(invoked).toBe(false); expect(s.snapshots[0].every(value => value === 0)).toBe(true); await owner.close();
});
it("a peer fence queued after positive Stop cannot begin ACL revocation or a read", async () => {
  const s = setup(), factory = s.dependencies.createStopOwner!;
  s.dependencies.createStopOwner = binding => {
    const actual = factory(binding);
    return { ...actual, stop: timeout => actual.stop(timeout).then(proof => { queueMicrotask(() => { s.dependencies.fence!.failure = new WindowsRootOnlyCommandCopyCleanupError(); }); return proof; }) };
  };
  const owner = await s.prepare(); await owner.launchRootOnly(s.create, s.attest);
  await expect(owner.files(async () => "forbidden")).rejects.toBeInstanceOf(WindowsRootOnlyCommandCopyCleanupError);
  expect(s.events.some(event => event.startsWith("revoke-"))).toBe(false); expect(s.events).not.toContain("snapshot"); expect(s.fence.retained).toContain(owner);
});
it("rejects Promise-returning attestation before Resume and retains the uncertain creator generation", async () => {
  const s = setup(), owner = await s.prepare(); let checked = false;
  const attester = async () => { await Promise.resolve(); checked = true; };
  await expect(owner.launchRootOnly(s.create, attester)).rejects.toBeInstanceOf(WindowsRootOnlyCommandCopyCleanupError);
  expect(s.events).not.toContain("resume"); expect(s.events).toContain("terminate-root"); expect(s.fence.retained).toContain(owner);
  await Promise.resolve(); expect(checked).toBe(true); expect(s.events.some(event => event.startsWith("revoke-"))).toBe(false);
});
it("cannot upgrade a review requested before Stop merely by retiring before its queued turn", async () => {
  const s = setup(), owner = await s.prepare(); let invoked = false;
  const premature = owner.review(async () => { invoked = true; });
  const observed = premature.catch(error => error), stopped = owner.stop();
  expect(await observed).toBeInstanceOf(ScopedCodingFileError); await stopped; expect(invoked).toBe(false); expect(s.events).not.toContain("snapshot"); await owner.close();
});
it.each(["work", "review"] as const)("a synchronous %s guard cannot retire/revoke this owner and still expose snapshot bytes", async mode => {
  const s = setup(), owner = await s.prepare(); if (mode === "review") await owner.stop(); let invoked = false, triggered = false;
  const hook = () => { if (s.snapshots.length && !triggered) { triggered = true; void (mode === "work" ? owner.stop() : owner.close()).catch(() => undefined); } };
  if (mode === "work") s.state.onCurrent = hook; else s.state.onReview = hook;
  const callback = async () => { invoked = true; };
  await expect(mode === "work" ? owner.files(callback) : owner.review(callback)).rejects.toBeInstanceOf(ScopedCodingFileError);
  expect(triggered).toBe(true); expect(invoked).toBe(false); expect(s.snapshots[0].every(value => value === 0)).toBe(true); await owner.close();
});
it("a work guard that synchronously poisons the shared fence cannot expose a completed snapshot", async () => {
  const s = setup(), owner = await s.prepare(); let invoked = false;
  s.state.onCurrent = () => { if (s.snapshots.length) s.dependencies.fence!.failure = new WindowsRootOnlyCommandCopyCleanupError(); };
  await expect(owner.files(async () => { invoked = true; })).rejects.toBeInstanceOf(WindowsRootOnlyCommandCopyCleanupError);
  expect(invoked).toBe(false); expect(s.snapshots[0].every(value => value === 0)).toBe(true); expect(s.fence.retained).toContain(owner);
});
